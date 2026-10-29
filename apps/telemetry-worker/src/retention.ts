import {
  TELEMETRY_V2_MAX_FUTURE_SKEW_MS,
  TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS,
  type TelemetryRetentionPolicy,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { BUCKET_MS } from "./time.ts";

/**
 * A dedupe row must outlive the whole window in which its delivery could still be accepted
 * (occurrence + max age), plus the clock-skew margin. After that a replay's occurrence is too old
 * to be counted at all, so deleting the row cannot permit a recount. This floor holds whatever a
 * policy says: a policy can lengthen dedupe retention but never shorten it below the horizon.
 */
export const DEDUPE_RETENTION_AFTER_OCCURRENCE_MS = TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + TELEMETRY_V2_MAX_FUTURE_SKEW_MS;

/**
 * The policy as the aggregate object persists and applies it: milliseconds only. The approval
 * reference is checked at admission and deliberately not stored next to the data.
 */
export interface AppliedRetention {
  readonly policyRevision: string;
  readonly effectiveFromMs: number;
  readonly approvedUntilMs: number;
  readonly dedupeMs: number;
  readonly rollupMs: number;
  readonly healthMs: number;
}

export function toApplied(policy: TelemetryRetentionPolicy): AppliedRetention {
  return {
    policyRevision: policy.policyRevision,
    effectiveFromMs: policy.effectiveFromMs,
    approvedUntilMs: policy.approvedUntilMs,
    // Durations are rounded UP to the 15-minute grid, so every expiry derived from them stays on it.
    dedupeMs: ceilToBucket(policy.dedupeSeconds * 1000),
    rollupMs: ceilToBucket(policy.rollupSeconds * 1000),
    healthMs: ceilToBucket(policy.healthSeconds * 1000),
  };
}

/**
 * Stored deletion times are derived from the END of a 15-minute bucket (already coarse) or rounded
 * UP to that grid, so an expiry reveals no sub-bucket event time and never shortens a retention.
 */
export function ceilToBucket(ms: number): number {
  return Math.ceil(ms / BUCKET_MS) * BUCKET_MS;
}

export function bucketEnd(bucketStartMs: number): number {
  return bucketStartMs + BUCKET_MS;
}

export function dedupeExpiry(bucketStartMs: number, applied: AppliedRetention): number {
  return bucketEnd(bucketStartMs) + Math.max(applied.dedupeMs, DEDUPE_RETENTION_AFTER_OCCURRENCE_MS);
}

export function rollupExpiry(bucketStartMs: number, applied: AppliedRetention): number {
  return bucketEnd(bucketStartMs) + applied.rollupMs;
}

export function healthExpiry(nowMs: number, applied: AppliedRetention): number {
  return ceilToBucket(nowMs + applied.healthMs);
}

/**
 * A bucket stays provisional while a late delivery could still revise it: an occurrence is accepted
 * for the occurrence-age horizon (plus skew) after it happens, so for that long after the bucket ends.
 */
export function bucketProvisional(bucketStartMs: number, nowMs: number): boolean {
  return nowMs < bucketEnd(bucketStartMs) + DEDUPE_RETENTION_AFTER_OCCURRENCE_MS;
}
