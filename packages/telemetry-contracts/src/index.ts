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
  if (input === undefined || input.length === 0 || input.length > 128 * 1024) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { return null; }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const entries = Object.entries(decoded);
  if (entries.length === 0 || entries.length > 500) return null;
  const map = new Map<string, TenantTelemetryGrant>();
  for (const [tenant, raw] of entries) {
    if (!TENANT_ID.test(tenant) || raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const grant = raw as Record<string, unknown>;
    if (Object.keys(grant).some((key) => !["source", "gradeBands", "signingKey"].includes(key))) return null;
    if (typeof grant.source !== "string" || !allowedSource.has(grant.source)) return null;
    if (!Array.isArray(grant.gradeBands) || grant.gradeBands.length === 0 ||
        grant.gradeBands.length > GRADE_BANDS.length ||
        grant.gradeBands.some((g: unknown) => typeof g !== "string" || !allowedGrades.has(g)) ||
        new Set(grant.gradeBands).size !== grant.gradeBands.length) return null;
    if (typeof grant.signingKey !== "string" ||
        grant.signingKey.length < 32 || grant.signingKey.length > 512 ||
        /[^\x21-\x7E]/.test(grant.signingKey)) return null;
    map.set(tenant, {
      source: grant.source as Source,
      gradeBands: grant.gradeBands as GradeBand[],
      signingKey: grant.signingKey,
    });
  }
  return map;
}

/** Grant must match both the trusted tenant and the event's fixed source/grade. */
export function grantAllowsBatch(grant: TenantTelemetryGrant, batch: TelemetryBatch): boolean {
  return batch.events.every((event) =>
    event.source === grant.source && grant.gradeBands.includes(event.gradeBand));
}
