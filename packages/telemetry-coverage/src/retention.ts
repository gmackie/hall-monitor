import {
  parseTelemetryRetentionPolicy,
  TELEMETRY_V2_MAX_RETENTION_SECONDS,
  TELEMETRY_V2_MIN_DEDUPE_SECONDS,
  type TelemetryRetentionPolicy,
} from "@gmacko/hall-monitor-telemetry-contracts";

/** Experimental ordering constraint only; this does not establish count availability or coverage. */
export interface ExperimentalCoverageRetentionPolicy extends TelemetryRetentionPolicy {
  readonly coverageSeconds: number;
}

/** Separate from the live eight-key parser. No production caller admits this document. */
export function parseCoverageRetentionPolicy(value: unknown): ExperimentalCoverageRetentionPolicy | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { coverageSeconds, ...base } = value as Record<string, unknown>;
  if (!Object.hasOwn(value, "coverageSeconds")) return null;
  const policy = parseTelemetryRetentionPolicy(base);
  if (policy === null || typeof coverageSeconds !== "number" || !Number.isInteger(coverageSeconds) ||
      coverageSeconds < TELEMETRY_V2_MIN_DEDUPE_SECONDS || coverageSeconds > TELEMETRY_V2_MAX_RETENTION_SECONDS ||
      coverageSeconds < policy.rollupSeconds || coverageSeconds > policy.gapSeconds) return null;
  return { ...policy, coverageSeconds };
}
