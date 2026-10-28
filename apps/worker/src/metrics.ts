import type { EvaluationRequest, EvaluationResult } from "@gmacko/hall-monitor-contracts";
import {
  TELEMETRY_V2_DEFAULT_RETRY_HORIZON_MS,
  TELEMETRY_V2_MAX_RETRY_HORIZON_MS,
  buildTelemetryDeliveryV2,
  grantAllowsBatch,
  newDeliveryId,
  parseTelemetryProducerTenantsV2,
  parseTelemetryTenants,
  type GradeBand,
  type Source,
  type TelemetryBatch,
  type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { sendTelemetry } from "@gmacko/hall-monitor-telemetry-sink";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import type { TelemetryInput } from "./store.ts";

/** Student grade is derived from a pinned, approved policy—not a caller-supplied label. */
function profileGradeBand(profileId: string): GradeBand {
  switch (profileId) {
    case "student-6-8": return "g6_8";
    case "student-9-12": return "g9_12";
    case "educator": return "adult";
    default: return "unspecified";
  }
}

function sourceOf(product: string): Source | null {
  switch (product) {
    case "educateos": return "educateos";
    case "playtrek": return "playtrek";
    case "hall-monitor": return "hall_monitor";
    default: return null;
  }
}

/** Pure content-free projection; no request ID, subject, message, source.surface or token. */
export function evaluationMetrics(
  request: EvaluationRequest,
  result: EvaluationResult,
  occurredAt: string,
): TelemetryBatch | null {
  const source = sourceOf(request.source.product);
  if (source === null) return null;
  const gradeBand = profileGradeBand(request.policy.profileId);
  const modality: TemporalMetricEvent["modality"] =
    request.content.type === "image" ?
      (request.content.text === undefined ? "image" : "mixed") :
      request.content.type === "text" ? "text" : "other";

  const evaluated: TemporalMetricEvent = {
    schemaVersion: 1,
    occurredAt,
    kind: "content_evaluated",
    category: "none",
    priority: "routine",
    modality,
    gradeBand,
    source,
    // The source Worker has no trusted district calendar or local time-zone binding.
    calendarKind: "unknown",
  };
  const events: TemporalMetricEvent[] = [evaluated];
  // This flag is explicitly an *operational candidate*, not a substantiated safety
  // incident. Skip holds caused only by classifier failures or budget/uncertainty.
  const candidate = result.degraded === undefined && !result.uncertain &&
    result.findings.some((f) =>
      ["harassment", "hate", "sexual", "violence", "self-harm", "privacy", "safety"].includes(f.category) &&
      ["warn", "hold", "block", "support"].includes(f.severity));
  if (candidate) events.push({
    ...evaluated,
    kind: "candidate_flagged",
    // T1 deliberately does not transmit detailed sensitive categories or urgency.
    category: "other",
  });
  return { schemaVersion: 1, events };
}

export const DEFAULT_OUTBOX_MAX_ROWS = 500;
export const DEFAULT_OUTBOX_MAX_BYTES = 1024 * 1024;

/** A positive integer from an optional setting, clamped to `max`; anything else is the default. */
function boundedSetting(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/**
 * Projects the v2 delivery to persist with a completing evaluation (HM-20), BEFORE the result is
 * committed, so the store can write it in the same transaction. Null when v2 is not enabled for
 * this tenant or nothing is projectable: not enrolled is not a gap. Once a tenant is enrolled,
 * an unexpected failure returns a gap marker instead, so the lost coverage is still counted.
 *
 * The occurrence time, delivery ID and producer revision are fixed here, once; retries re-send
 * these same bytes. This never touches the v1 settings or emission, and never throws.
 */
export async function prepareTelemetryDelivery(
  env: Env,
  tenant: string,
  request: EvaluationRequest,
  result: EvaluationResult,
): Promise<TelemetryInput | null> {
  if (env.HM_TELEMETRY_V2_ENABLED !== "true" || env.METRICS_COLLECTOR === undefined) return null;
  const occurredAtMs = Date.now();
  try {
    const grant = parseTelemetryProducerTenantsV2(env.HM_TELEMETRY_V2_TENANTS)?.get(tenant);
    if (grant === undefined) return null;
    const batch = evaluationMetrics(request, result, new Date(occurredAtMs).toISOString());
    if (batch === null || !grantAllowsBatch(grant, batch)) return null;
    try {
      const built = await buildTelemetryDeliveryV2({
        deliveryId: newDeliveryId(),
        producerRevision: grant.producerRevision,
        events: batch.events,
      });
      return {
        kind: "delivery",
        deliveryId: built.delivery.deliveryId,
        digest: built.digest,
        payload: built.payload,
        occurredAtMs,
        retryHorizonMs:
          boundedSetting(env.HM_TELEMETRY_RETRY_HORIZON_SECONDS, TELEMETRY_V2_DEFAULT_RETRY_HORIZON_MS / 1000, TELEMETRY_V2_MAX_RETRY_HORIZON_MS / 1000) * 1000,
        maxRows: boundedSetting(env.HM_TELEMETRY_OUTBOX_MAX_ROWS, DEFAULT_OUTBOX_MAX_ROWS, 5000),
        maxBytes: boundedSetting(env.HM_TELEMETRY_OUTBOX_MAX_BYTES, DEFAULT_OUTBOX_MAX_BYTES, 8 * 1024 * 1024),
      };
    } catch {
      log("warn", "telemetry.delivery_failed", { tenant, reason: "error" });
      return { kind: "gap", occurredAtMs, reason: "error" };
    }
  } catch {
    log("warn", "telemetry.delivery_failed", { tenant, reason: "error" });
    return null;
  }
}

/**
 * Only called AFTER the idempotency record was committed, never on a replay or
 * a failed/unauthorized request. All approval controls are independently required.
 *
 * The event is accepted but discarded by the T1 collector; no durable analytics
 * or verified counts are created until T2. Telemetry failure never changes the
 * moderation decision, returns content, retries implicitly or switches providers.
 */
export function scheduleEvaluationMetrics(
  env: Env,
  tenant: string,
  request: EvaluationRequest,
  result: EvaluationResult,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): void {
  if (env.HM_TELEMETRY_ENABLED !== "true" || ctx === undefined ||
      env.METRICS_COLLECTOR === undefined) return;
  try {
    const tenants = parseTelemetryTenants(env.HM_TELEMETRY_TENANTS);
    const grant = tenants?.get(tenant);
    if (grant === undefined) return;
    const batch = evaluationMetrics(request, result, new Date().toISOString());
    if (batch === null || batch.events.some((event) =>
      event.source !== grant.source || !grant.gradeBands.includes(event.gradeBand))) return;

    const delivery = sendTelemetry(env.METRICS_COLLECTOR, tenant, grant.signingKey, batch)
      .then((accepted) => {
        if (!accepted) log("warn", "telemetry.delivery_failed", { tenant });
      })
      .catch(() => {
        // Never log exception.message, headers or raw payload.
        log("warn", "telemetry.delivery_failed", { tenant });
      });
    ctx.waitUntil(delivery);
  } catch {
    // No privacy config, validator or telemetry failure may change a moderation
    // decision after it has been durably committed.
    log("warn", "telemetry.delivery_failed", { tenant });
  }
}
