import {
  GRADE_BANDS, SOURCES, parseTemporalMetricEvent,
  type GradeBand, type Source, type TemporalMetricEvent,
} from "@gmacko/hall-monitor-temporal-analytics";

export type { TemporalMetricEvent, GradeBand, Source };
export { parseTemporalMetricEvent };

export const MAX_TELEMETRY_EVENTS = 16;
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024;
export const TELEMETRY_PATH = "/internal/v1/telemetry";
export const TENANT_HEADER = "x-hm-telemetry-tenant";
export const TIME_HEADER = "x-hm-telemetry-time";
export const SIGNATURE_HEADER = "x-hm-telemetry-signature";
export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface TelemetryBatch {
  readonly schemaVersion: 1;
  readonly events: readonly TemporalMetricEvent[];
}

export interface TenantTelemetryGrant {
  readonly source: Source;
  readonly gradeBands: readonly GradeBand[];
  /** Per-tenant HMAC key. This value is a secret and must never enter logs or analytics. */
  readonly signingKey: string;
}

export type TelemetryTenants = ReadonlyMap<string, TenantTelemetryGrant>;

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const allowedSource = new Set<string>(SOURCES);
const allowedGrades = new Set<string>(GRADE_BANDS);

/** Fixed envelope. The only extensible data format belongs in a new explicit schema version. */
export function parseTelemetryBatch(value: unknown): TelemetryBatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid telemetry envelope");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "schemaVersion" && key !== "events")) {
    throw new TypeError("unknown telemetry envelope field");
  }
  if (record.schemaVersion !== 1 ||
      !Array.isArray(record.events) ||
      record.events.length < 1 ||
      record.events.length > MAX_TELEMETRY_EVENTS) {
    throw new TypeError("invalid telemetry envelope version or length");
  }
  return { schemaVersion: 1, events: record.events.map(parseTemporalMetricEvent) };
}

/**
 * Strict source/grade allowlist plus a 32+ character per-tenant signing key.
 * Invalid or absent settings **never** authorize a tenant. No implicit wildcard.
 */
export function parseTelemetryTenants(input: string | undefined): TelemetryTenants | null {
  const parsed = parseGrantEntries(input, null);
  if (parsed === null) return null;
  return new Map([...parsed].map(([tenant, entry]) => [tenant, entry.grant]));
}

/**
 * Shared strict grant parser. `extraKey` names the one additional field a versioned grant
 * carries (returned raw, for the caller to validate); v1 passes null and accepts no extra key.
 */
function parseGrantEntries(
  input: string | undefined,
  extraKey: string | null,
): Map<string, { grant: TenantTelemetryGrant; extra: unknown }> | null {
  if (input === undefined || input.length === 0 || input.length > 128 * 1024) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { return null; }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const entries = Object.entries(decoded);
  if (entries.length === 0 || entries.length > 500) return null;
  const allowedKeys = extraKey === null ? ["source", "gradeBands", "signingKey"] : ["source", "gradeBands", "signingKey", extraKey];
  const map = new Map<string, { grant: TenantTelemetryGrant; extra: unknown }>();
  for (const [tenant, raw] of entries) {
    if (!TENANT_ID.test(tenant) || raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const grant = raw as Record<string, unknown>;
    if (Object.keys(grant).some((key) => !allowedKeys.includes(key))) return null;
    if (typeof grant.source !== "string" || !allowedSource.has(grant.source)) return null;
    if (!Array.isArray(grant.gradeBands) || grant.gradeBands.length === 0 ||
        grant.gradeBands.length > GRADE_BANDS.length ||
        grant.gradeBands.some((g: unknown) => typeof g !== "string" || !allowedGrades.has(g)) ||
        new Set(grant.gradeBands).size !== grant.gradeBands.length) return null;
    if (typeof grant.signingKey !== "string" ||
        grant.signingKey.length < 32 || grant.signingKey.length > 512 ||
        /[^\x21-\x7E]/.test(grant.signingKey)) return null;
    map.set(tenant, {
      grant: {
        source: grant.source as Source,
        gradeBands: grant.gradeBands as GradeBand[],
        signingKey: grant.signingKey,
      },
      extra: extraKey === null ? undefined : grant[extraKey],
    });
  }
  return map;
}

/** Grant must match both the trusted tenant and the event's fixed source/grade. */
export function grantAllowsBatch(grant: TenantTelemetryGrant, batch: TelemetryBatch): boolean {
  return batch.events.every((event) =>
    event.source === grant.source && grant.gradeBands.includes(event.gradeBand));
}

/**
 * T1 does not accept user reports, case transitions, detailed category labels or
 * supposed urgent events. Those require a distinct authorized T2+ source protocol.
 * Only a fresh evaluation, optionally followed by one coarse candidate flag, may
 * reach this validate-and-discard receiver.
 */
export function isT1EvaluationBatch(batch: TelemetryBatch): boolean {
  return isEvaluationPair(batch.events);
}

/**
 * The only event shape the evaluator emits: one `content_evaluated`, optionally followed by one
 * matching coarse `candidate_flagged`. The pair is indivisible: v2 never carries or counts half.
 */
export function isEvaluationPair(events: readonly TemporalMetricEvent[]): boolean {
  if (events.length < 1 || events.length > 2) return false;
  const first = events[0]!;
  if (first.kind !== "content_evaluated" || first.category !== "none" ||
      first.priority !== "routine" || first.calendarKind !== "unknown" ||
      first.reviewLatencyMs !== undefined) return false;
  if (events.length === 1) return true;
  const next = events[1]!;
  return next.kind === "candidate_flagged" &&
    next.category === "other" && next.priority === "routine" &&
    next.calendarKind === "unknown" &&
    next.reviewLatencyMs === undefined &&
    next.occurredAt === first.occurredAt &&
    next.source === first.source &&
    next.modality === first.modality &&
    next.gradeBand === first.gradeBand;
}

// ---------------------------------------------------------------------------------------------
// v2: durable delivery envelope and acknowledgment (HM-20 / W6).
//
// v2 is a separate protocol, not an extension of v1: its own path, its own HMAC domains and its
// own strict schemas, so a v1 signature or a v1 `202 persisted:false` can never stand in for it.
// The delivery ID and producer revision exist ONLY in this protected transport envelope; they are
// never part of a TemporalMetricEvent. The opaque delivery ID is never an analytics dimension; the
// producer revision is, deliberately, but only as a server-approved, bounded value (W8a pins it
// per tenant and effective interval, so a caller can never introduce a new one).
// ---------------------------------------------------------------------------------------------

export const TELEMETRY_V2_PATH = "/internal/v2/telemetry";
/** HMAC domain prefixes. Distinct from v1's `hall-monitor-telemetry-v1`, and from each other. */
export const TELEMETRY_V2_REQUEST_DOMAIN = "hall-monitor-telemetry-v2";
export const TELEMETRY_V2_ACK_DOMAIN = "hall-monitor-telemetry-ack-v2";
export const MAX_TELEMETRY_V2_BODY_BYTES = 16 * 1024;
export const MAX_TELEMETRY_ACK_BYTES = 1024;

/**
 * Longest age of an occurrence the receiver will still count. A producer's retry horizon is
 * capped well inside it, so an in-horizon retry is always acceptable; later re-signed replays
 * are not.
 */
export const TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS = 24 * 60 * 60 * 1000;
export const TELEMETRY_V2_MAX_RETRY_HORIZON_MS = 12 * 60 * 60 * 1000;
export const TELEMETRY_V2_DEFAULT_RETRY_HORIZON_MS = 6 * 60 * 60 * 1000;
/** How far an occurrence may lie in the receiver's future. */
export const TELEMETRY_V2_MAX_FUTURE_SKEW_MS = MAX_CLOCK_SKEW_SECONDS * 1000;

const DELIVERY_ID = /^dlv_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PRODUCER_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A delivery: one evaluation's indivisible event pair plus its protected transport identity. */
export interface TelemetryDeliveryV2 {
  readonly schemaVersion: 2;
  /** Opaque random ID, stable across retries. Not derived from any request, message or student. */
  readonly deliveryId: string;
  /** Server-owned producer/config revision; the receiver restricts per tenant to approved ones. */
  readonly producerRevision: string;
  readonly events: readonly TemporalMetricEvent[];
}

/** A fresh opaque delivery ID. */
export function newDeliveryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "dlv_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isDeliveryId(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_ID.test(value);
}

export function isProducerRevision(value: unknown): value is string {
  return typeof value === "string" && PRODUCER_REVISION.test(value);
}

/** Strict v2 envelope: exact fields, a valid ID and revision, and exactly an evaluation pair. */
export function parseTelemetryDeliveryV2(value: unknown): TelemetryDeliveryV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid telemetry delivery");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !["schemaVersion", "deliveryId", "producerRevision", "events"].every((k) => keys.includes(k))) {
    throw new TypeError("invalid telemetry delivery fields");
  }
  if (record.schemaVersion !== 2 || !isDeliveryId(record.deliveryId) || !isProducerRevision(record.producerRevision) ||
      !Array.isArray(record.events) || record.events.length < 1 || record.events.length > 2) {
    throw new TypeError("invalid telemetry delivery");
  }
  const events = record.events.map(parseTemporalMetricEvent);
  if (!isEvaluationPair(events)) throw new TypeError("telemetry delivery is not an evaluation pair");
  return { schemaVersion: 2, deliveryId: record.deliveryId, producerRevision: record.producerRevision, events };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The exact bytes that are stored in the outbox, signed and sent, with their digest. A retry
 * re-sends these same bytes (so the same ID and digest) under a fresh transport timestamp.
 */
export async function buildTelemetryDeliveryV2(
  input: { readonly deliveryId: string; readonly producerRevision: string; readonly events: readonly TemporalMetricEvent[] },
): Promise<{ readonly payload: string; readonly digest: string; readonly delivery: TelemetryDeliveryV2 }> {
  const delivery = parseTelemetryDeliveryV2({ schemaVersion: 2, ...input });
  const payload = JSON.stringify(delivery);
  if (new TextEncoder().encode(payload).byteLength > MAX_TELEMETRY_V2_BODY_BYTES) {
    throw new TypeError("telemetry delivery exceeds limit");
  }
  return { payload, digest: await sha256Hex(payload), delivery };
}

export type TelemetryAckStatus = "committed" | "deduplicated";

/**
 * The receiver's durable acknowledgment. `persisted:true` is a literal: it is only returned after
 * the whole pair's counters and dedupe state are committed in one transaction. `mac` binds the
 * status, delivery ID and payload digest to the tenant key under the ack domain.
 */
export interface TelemetryAckV2 {
  readonly schemaVersion: 2;
  readonly status: TelemetryAckStatus;
  readonly deliveryId: string;
  readonly digest: string;
  readonly persisted: true;
  readonly mac: string;
}

export function parseTelemetryAckV2(text: string): TelemetryAckV2 {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TypeError("invalid telemetry ack"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid telemetry ack");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 6 || !["schemaVersion", "status", "deliveryId", "digest", "persisted", "mac"].every((k) => keys.includes(k))) {
    throw new TypeError("invalid telemetry ack fields");
  }
  if (record.schemaVersion !== 2 || (record.status !== "committed" && record.status !== "deduplicated") ||
      !isDeliveryId(record.deliveryId) || typeof record.digest !== "string" || !DIGEST.test(record.digest) ||
      record.persisted !== true || typeof record.mac !== "string" || !DIGEST.test(record.mac)) {
    throw new TypeError("invalid telemetry ack");
  }
  return {
    schemaVersion: 2, status: record.status, deliveryId: record.deliveryId,
    digest: record.digest, persisted: true, mac: record.mac,
  };
}

/** Producer-side v2 enrolment: one server-owned revision per tenant. Separate from v1 grants. */
export interface TenantProducerGrantV2 extends TenantTelemetryGrant {
  readonly producerRevision: string;
}
export type TelemetryProducerTenantsV2 = ReadonlyMap<string, TenantProducerGrantV2>;

/** Receiver-side v2 enrolment: the producer revisions a tenant is approved to send. */
export interface TenantReceiverGrantV2 extends TenantTelemetryGrant {
  readonly producerRevisions: readonly string[];
}
export type TelemetryReceiverTenantsV2 = ReadonlyMap<string, TenantReceiverGrantV2>;

/** Strict producer enrolment. Absent, invalid or unknown-field settings never authorize a tenant. */
export function parseTelemetryProducerTenantsV2(input: string | undefined): TelemetryProducerTenantsV2 | null {
  const parsed = parseGrantEntries(input, "producerRevision");
  if (parsed === null) return null;
  const map = new Map<string, TenantProducerGrantV2>();
  for (const [tenant, { grant, extra }] of parsed) {
    if (!isProducerRevision(extra)) return null;
    map.set(tenant, { ...grant, producerRevision: extra });
  }
  return map;
}

/** Strict receiver enrolment with an explicit approved-revision list per tenant. */
export function parseTelemetryReceiverTenantsV2(input: string | undefined): TelemetryReceiverTenantsV2 | null {
  const parsed = parseGrantEntries(input, "producerRevisions");
  if (parsed === null) return null;
  const map = new Map<string, TenantReceiverGrantV2>();
  for (const [tenant, { grant, extra }] of parsed) {
    if (!Array.isArray(extra) || extra.length < 1 || extra.length > 16 ||
        !extra.every(isProducerRevision) || new Set(extra).size !== extra.length) return null;
    map.set(tenant, { ...grant, producerRevisions: extra as string[] });
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// v2 retention policy (HM-21 / W8a).
//
// A retention policy is SERVER-OWNED configuration naming how long each kind of stored telemetry
// state lives. It is supplied by an authorized operator, together with an opaque reference to the
// approval it implements; this code never invents a duration and never defaults one. A tenant with
// no valid, currently effective policy collects nothing and stores nothing. A synthetic value in a
// test is not an approval.
// ---------------------------------------------------------------------------------------------

/** Dedupe state must outlive the entire accepted occurrence window plus the clock-skew margin. */
export const TELEMETRY_V2_MIN_DEDUPE_SECONDS = Math.ceil(
  (TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + TELEMETRY_V2_MAX_FUTURE_SKEW_MS) / 1000,
);
export const TELEMETRY_V2_MIN_HEALTH_SECONDS = 60 * 60;
export const TELEMETRY_V2_MAX_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;

export interface TelemetryRetentionPolicy {
  /** Opaque revision of the approved policy. */
  readonly policyRevision: string;
  /** Opaque reference supplied by the authorizing operator. Never interpreted, never stored with data. */
  readonly approvalRef: string;
  /** The policy is in force from this instant (inclusive, UTC epoch ms) ... */
  readonly effectiveFromMs: number;
  /** ... until this one (exclusive). Past it, the tenant fails closed for telemetry. */
  readonly approvedUntilMs: number;
  /** Protected dedupe digests, measured from the END of the occurrence's 15-minute bucket. */
  readonly dedupeSeconds: number;
  /** Rollup counters, measured from the end of their bucket. */
  readonly rollupSeconds: number;
  /** Operational ingest health, measured from the last ingest. */
  readonly healthSeconds: number;
  /** Producer coverage-gap markers, measured from the end of their UTC occurrence hour. */
  readonly gapSeconds: number;
}

const POLICY_KEYS = [
  "policyRevision", "approvalRef", "effectiveFrom", "approvedUntil",
  "dedupeSeconds", "rollupSeconds", "healthSeconds", "gapSeconds",
];
const APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/# -]{0,127}$/;
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A strict explicit-UTC ISO instant as epoch ms, or null. Impossible dates (Feb 30) are rejected. */
export function parseUtcInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== match[1]) return null;
  return ms;
}

function retentionSeconds(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= TELEMETRY_V2_MAX_RETENTION_SECONDS
    ? value : null;
}

/**
 * Strict retention policy, or null. Beyond field validity it enforces that the policy is internally
 * consistent and covers the whole accepted horizon: dedupe state outlives the occurrence window (so
 * an expired rollup can never be recreated by a re-signed replay), rollups outlive dedupe state, and
 * coverage-gap evidence outlives the rollups it qualifies. Anything else is not a usable policy.
 */
export function parseTelemetryRetentionPolicy(value: unknown): TelemetryRetentionPolicy | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== POLICY_KEYS.length || !POLICY_KEYS.every((k) => keys.includes(k))) return null;
  if (!isProducerRevision(record.policyRevision)) return null;
  if (typeof record.approvalRef !== "string" || !APPROVAL_REF.test(record.approvalRef)) return null;
  const effectiveFromMs = parseUtcInstant(record.effectiveFrom);
  const approvedUntilMs = parseUtcInstant(record.approvedUntil);
  const dedupeSeconds = retentionSeconds(record.dedupeSeconds, TELEMETRY_V2_MIN_DEDUPE_SECONDS);
  const rollupSeconds = retentionSeconds(record.rollupSeconds, TELEMETRY_V2_MIN_DEDUPE_SECONDS);
  const healthSeconds = retentionSeconds(record.healthSeconds, TELEMETRY_V2_MIN_HEALTH_SECONDS);
  const gapSeconds = retentionSeconds(record.gapSeconds, TELEMETRY_V2_MIN_DEDUPE_SECONDS);
  if (effectiveFromMs === null || approvedUntilMs === null || dedupeSeconds === null || rollupSeconds === null ||
      healthSeconds === null || gapSeconds === null) return null;
  if (approvedUntilMs <= effectiveFromMs || approvedUntilMs - effectiveFromMs > TELEMETRY_V2_MAX_RETENTION_SECONDS * 1000) return null;
  if (rollupSeconds < dedupeSeconds || gapSeconds < rollupSeconds) return null;
  return {
    policyRevision: record.policyRevision, approvalRef: record.approvalRef,
    effectiveFromMs, approvedUntilMs, dedupeSeconds, rollupSeconds, healthSeconds, gapSeconds,
  };
}

/** Whether the policy is in force at `nowMs`. An expired or not-yet-effective policy admits nothing. */
export function retentionPolicyActive(policy: TelemetryRetentionPolicy, nowMs: number): boolean {
  return policy.effectiveFromMs <= nowMs && nowMs < policy.approvedUntilMs;
}

/** Producer-side policies, one per tenant. Any invalid entry invalidates the whole setting. */
export type TelemetryProducerRetentionV2 = ReadonlyMap<string, TelemetryRetentionPolicy>;

export function parseTelemetryProducerRetentionV2(input: string | undefined): TelemetryProducerRetentionV2 | null {
  if (input === undefined || input.length === 0 || input.length > 64 * 1024) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { return null; }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const entries = Object.entries(decoded);
  if (entries.length === 0 || entries.length > 500) return null;
  const map = new Map<string, TelemetryRetentionPolicy>();
  for (const [tenant, raw] of entries) {
    const policy = TENANT_ID.test(tenant) ? parseTelemetryRetentionPolicy(raw) : null;
    if (policy === null) return null;
    map.set(tenant, policy);
  }
  return map;
}
