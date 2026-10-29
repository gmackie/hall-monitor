import {
  TELEMETRY_PATH, TELEMETRY_V2_PATH, TENANT_HEADER,
  grantAllowsBatch, isT1EvaluationBatch, parseTelemetryReceiverTenantsV2, parseTelemetryTenants, sha256Hex,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { signTelemetryAckV2, verifyDeliveryRequestV2, verifyTelemetryRequest } from "@gmacko/hall-monitor-telemetry-sink";
import { DEFAULT_MAX_DEDUPE_ROWS, TelemetryAggregateStore } from "./store.ts";
import { resolveTenantConfigsV2 } from "./tenant-config.ts";
import { bucketStartOf, deriveTrustedDimensions, resolveInterval } from "./time.ts";

export { TelemetryAggregateStore } from "./store.ts";

export interface TelemetryEnv {
  /** v1: `validate_only` enables the validate-and-discard route. Unset: disabled. */
  readonly HM_TELEMETRY_ACCEPT?: string;
  readonly HM_TELEMETRY_TENANTS?: string;
  /** v2: the exact string `aggregate` enables the exact-aggregate route. Separate from v1. */
  readonly HM_TELEMETRY_V2_ACCEPT?: string;
  /** v2 per-tenant grants: source, grade bands, signing key and the approved producer revisions. */
  readonly HM_TELEMETRY_V2_TENANTS?: string;
  /**
   * v2 per-tenant trusted configuration (W8a): district zone, effective-dated calendar, approved
   * producer revisions per interval and the approved retention policy. Required: without a valid,
   * non-conflicting value the route stores nothing. See docs/implementation/t2-durable-telemetry.md.
   */
  readonly HM_TELEMETRY_V2_CONFIG?: string;
  /** Optional bound on short-lived dedupe rows per tenant. */
  readonly HM_TELEMETRY_MAX_DEDUPE_ROWS?: string;
  /** One SQLite object per tenant holding dedupe digests and aggregate counters. */
  readonly AGGREGATES?: DurableObjectNamespace<TelemetryAggregateStore>;
}

function reply(status: number, code: string, accepted?: number): Response {
  // Only fixed machine codes and counts; no body, student data or error messages in response.
  return new Response(JSON.stringify({
    code, ...(accepted === undefined ? {} : { accepted, persisted: false }),
  }), {
    status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Routes by protocol. v1 (`/internal/v1/telemetry`) is the unchanged T1 validate-and-discard
 * receiver; v2 (`/internal/v2/telemetry`) is the opt-in exact-aggregate receiver. Each has its own
 * enable switch, grants and signature domain, and one never enables or accepts the other.
 */
export async function handleTelemetry(request: Request, env: TelemetryEnv): Promise<Response> {
  if (new URL(request.url).pathname === TELEMETRY_V2_PATH) return handleAggregateV2(request, env);
  return handleValidateOnly(request, env);
}

/**
 * An authenticated *validate-and-discard* T1 receiver for service bindings.
 * No event data is logged, persisted, forwarded or exported. Public access is
 * separately prohibited in wrangler.jsonc (workers_dev=false and no routes).
 * Tenant-specific HMAC prevents unauthenticated injection if deployed wrongly.
 */
async function handleValidateOnly(request: Request, env: TelemetryEnv): Promise<Response> {
  if (new URL(request.url).pathname !== TELEMETRY_PATH) return reply(404, "not_found");
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  if (env.HM_TELEMETRY_ACCEPT !== "validate_only") return reply(503, "disabled");
  const grants = parseTelemetryTenants(env.HM_TELEMETRY_TENANTS);
  if (grants === null) return reply(503, "invalid_configuration");
  const tenant = request.headers.get(TENANT_HEADER);
  if (tenant === null) return reply(401, "unauthorized");
  const grant = grants.get(tenant);
  if (grant === undefined) return reply(403, "forbidden");
  try {
    const verified = await verifyTelemetryRequest(request, grant.signingKey);
    if (verified.tenant !== tenant ||
        !grantAllowsBatch(grant, verified.batch) ||
        !isT1EvaluationBatch(verified.batch)) return reply(403, "forbidden");
    return reply(202, "validated_not_persisted", verified.batch.events.length);
  } catch {
    // Intentionally indistinguishable for bad signature, malformed content and
    // invalid fields, to avoid reflecting private data or validation internals.
    return reply(401, "unauthorized");
  }
}

function maxDedupeRows(value: string | undefined): number {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000_000) : DEFAULT_MAX_DEDUPE_ROWS;
}

/**
 * The opt-in v2 route. It authenticates under the v2 signature domain, restricts each tenant to
 * its approved source, grade bands and producer revisions, and counts the delivery's whole
 * evaluated/candidate pair exactly once in a tenant-scoped SQLite object. Only after that
 * transaction commits (or finds the same delivery already committed) does it return a signed
 * durable acknowledgment; any other outcome yields no ack, so the producer keeps retrying.
 *
 * Nothing is logged: this Worker has no logging path that could carry a payload or identifier.
 */
async function handleAggregateV2(request: Request, env: TelemetryEnv): Promise<Response> {
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  if (env.HM_TELEMETRY_V2_ACCEPT !== "aggregate") return reply(503, "disabled");
  const grants = parseTelemetryReceiverTenantsV2(env.HM_TELEMETRY_V2_TENANTS);
  if (grants === null || env.AGGREGATES === undefined) return reply(503, "invalid_configuration");
  // No tenant configuration (zone, calendar, approved revisions, retention policy) means no
  // aggregate writes at all, for any tenant. Conflicting configuration is treated the same way.
  const configs = resolveTenantConfigsV2(env.HM_TELEMETRY_V2_CONFIG, grants);
  if (configs === null) return reply(503, "invalid_configuration");
  const tenant = request.headers.get(TENANT_HEADER);
  if (tenant === null) return reply(401, "unauthorized");
  const grant = grants.get(tenant);
  if (grant === undefined) return reply(403, "forbidden");

  let verified;
  try {
    verified = await verifyDeliveryRequestV2(request, grant.signingKey);
  } catch {
    // Bad signature, malformed JSON, unknown field, wrong event kind or a split pair are
    // indistinguishable: a signed request still cannot carry anything but an evaluation pair.
    return reply(401, "unauthorized");
  }
  if (verified.tenant !== tenant ||
      !grantAllowsBatch(grant, { schemaVersion: 1, events: verified.delivery.events }) ||
      !grant.producerRevisions.includes(verified.delivery.producerRevision)) return reply(403, "forbidden");

  // The server-owned configuration decides everything about time and retention. It is resolved only
  // now, after the request is authenticated, because a revoked tenant's purge is a state change.
  const config = configs.get(tenant);
  if (config === undefined) return reply(403, "forbidden");
  const store = env.AGGREGATES.get(env.AGGREGATES.idFromName(`tenant:${tenant}`));
  if (config.state === "revoked") {
    try { await store.revoke(); } catch { return reply(503, "unavailable"); }
    return reply(403, "retention_unapproved");
  }
  const occurredAt = Date.parse(verified.delivery.events[0]!.occurredAt);
  // The interval effective at the ORIGINAL occurrence pins the zone, calendar and approved producer
  // revisions. An occurrence in no configured interval, or from a revision not approved for that
  // interval, is refused: it is never assigned a guess.
  const interval = resolveInterval(config.intervals, occurredAt);
  if (interval === null) return reply(422, "unconfigured_occurrence");
  if (!interval.producerRevisions.includes(verified.delivery.producerRevision)) return reply(403, "forbidden");
  let time;
  try {
    time = deriveTrustedDimensions(config.configRevision, interval, bucketStartOf(occurredAt));
  } catch {
    // The 15-minute bucket straddles a local hour or offset change (or the zone cannot be converted
    // exactly): mixing would be untruthful, so it is refused rather than rounded.
    return reply(422, "unsupported_alignment");
  }

  let outcome;
  try {
    outcome = await store.ingest({
      // Domain-separated SHA-256 of tenant + random delivery ID. It is not a keyed MAC; the raw ID
      // simply never reaches the aggregate object.
      deliveryKey: await sha256Hex("hall-monitor-telemetry-delivery-key-v2\n" + tenant + "\n" + verified.delivery.deliveryId),
      digest: verified.digest,
      producerRevision: verified.delivery.producerRevision,
      events: verified.delivery.events,
      maxDedupeRows: maxDedupeRows(env.HM_TELEMETRY_MAX_DEDUPE_ROWS),
      time,
      retention: config.retention,
    });
  } catch {
    return reply(503, "unavailable");
  }
  switch (outcome.kind) {
    case "committed":
    case "deduplicated":
      return new Response(
        JSON.stringify(await signTelemetryAckV2(tenant, grant.signingKey, outcome.kind, verified.delivery.deliveryId, verified.digest)),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
      );
    case "conflict": return reply(409, "digest_conflict");
    case "stale": return reply(422, "stale_occurrence");
    case "future": return reply(422, "future_occurrence");
    case "retention": return reply(403, "retention_unapproved");
    // A revision id already names different local dimensions for this bucket: operator error.
    case "config_conflict": return reply(503, "invalid_configuration");
    case "capacity": return reply(503, "capacity");
  }
}

export default {
  fetch(request: Request, env: TelemetryEnv): Promise<Response> {
    return handleTelemetry(request, env);
  },
} satisfies ExportedHandler<TelemetryEnv>;
