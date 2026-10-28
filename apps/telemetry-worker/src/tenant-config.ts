import {
  isProducerRevision,
  parseTelemetryRetentionPolicy,
  parseUtcInstant,
  type TelemetryReceiverTenantsV2,
  type TelemetryRetentionPolicy,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { CALENDAR_KINDS, SOURCES, localTimeBucket, type CalendarKind, type Source } from "@gmacko/hall-monitor-temporal-analytics";
import { BUCKET_MS, type CalendarSpan, type TenantInterval } from "./time.ts";

/**
 * Server-owned, per-tenant trusted configuration (HM-21 / W8a): the setting `HM_TELEMETRY_V2_CONFIG`.
 * It is what turns an authenticated producer into a tenant with a known district zone, calendar,
 * approved producer revisions and an approved retention policy. Nothing in a delivery can supply,
 * select or override any of it.
 *
 *   { "<tenant>": {
 *       "schemaVersion": 1,
 *       "configRevision": "<opaque>",
 *       "source": "educateos",
 *       "state": "active" | "revoked",       // "revoked" requires, and only it allows, "revocationRef"
 *       "retention": { policyRevision, approvalRef, effectiveFrom, approvedUntil,
 *                      dedupeSeconds, rollupSeconds, healthSeconds, gapSeconds },
 *       "intervals": [ { "from", "to", "timeZone", "calendarRevision", "producerRevisions": [...],
 *                        "calendar": [ { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "kind": "holiday" } ] } ]
 *   } }
 *
 * Invalid, ambiguous or oversized configuration is `null`: it never partially authorizes anything.
 */
export interface TenantConfigV2 {
  readonly configRevision: string;
  readonly source: Source;
  readonly state: "active" | "revoked";
  readonly revocationRef: string | null;
  readonly retention: TelemetryRetentionPolicy;
  readonly intervals: readonly TenantInterval[];
}

export type TenantConfigsV2 = ReadonlyMap<string, TenantConfigV2>;

export const MAX_CONFIG_BYTES = 512 * 1024;
export const MAX_TENANT_INTERVALS = 16;
export const MAX_CALENDAR_SPANS = 400;
export const MAX_INTERVAL_MS = 800 * 24 * 60 * 60 * 1000;

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME_ZONE = /^(?:UTC|[A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REVOCATION_REF = /^[A-Za-z0-9][A-Za-z0-9._:/# -]{0,127}$/;
const CONFIG_KEYS = ["schemaVersion", "configRevision", "source", "state", "retention", "intervals"];
const INTERVAL_KEYS = ["from", "to", "timeZone", "calendarRevision", "producerRevisions", "calendar"];
const SPAN_KEYS = ["from", "to", "kind"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(record).length === keys.length && keys.every((key) => key in record);

function localDateMs(text: unknown): number | null {
  if (typeof text !== "string" || !LOCAL_DATE.test(text)) return null;
  const ms = Date.parse(text + "T00:00:00.000Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

function parseCalendar(value: unknown): CalendarSpan[] | null {
  if (!Array.isArray(value) || value.length > MAX_CALENDAR_SPANS) return null;
  const spans: CalendarSpan[] = [];
  for (const raw of value) {
    if (!isObject(raw) || !exactKeys(raw, SPAN_KEYS)) return null;
    const from = localDateMs(raw.from);
    const to = localDateMs(raw.to);
    if (from === null || to === null || to < from) return null;
    if (typeof raw.kind !== "string" || !(CALENDAR_KINDS as readonly string[]).includes(raw.kind)) return null;
    spans.push({ from: raw.from as string, to: raw.to as string, kind: raw.kind as CalendarKind });
  }
  spans.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  // One date has one classification. Overlap would make "which kind wins" ambiguous.
  for (let i = 1; i < spans.length; i++) if (spans[i]!.from <= spans[i - 1]!.to) return null;
  return spans;
}

function parseInterval(value: unknown): TenantInterval | null {
  if (!isObject(value) || !exactKeys(value, INTERVAL_KEYS)) return null;
  const fromMs = parseUtcInstant(value.from);
  const toMs = parseUtcInstant(value.to);
  // Both ends on a bucket boundary: a 15-minute bucket is never split between two revisions.
  // (Finer boundaries are an unsupported precision, not silently rounded.)
  if (fromMs === null || toMs === null || toMs <= fromMs || toMs - fromMs > MAX_INTERVAL_MS ||
      fromMs % BUCKET_MS !== 0 || toMs % BUCKET_MS !== 0) return null;
  if (typeof value.timeZone !== "string" || !TIME_ZONE.test(value.timeZone) || !validZone(value.timeZone, fromMs)) return null;
  if (!isProducerRevision(value.calendarRevision)) return null;
  const revisions = value.producerRevisions;
  if (!Array.isArray(revisions) || revisions.length < 1 || revisions.length > 16 ||
      !revisions.every(isProducerRevision) || new Set(revisions).size !== revisions.length) return null;
  const calendar = parseCalendar(value.calendar);
  if (calendar === null) return null;
  return {
    fromMs, toMs, timeZone: value.timeZone, calendarRevision: value.calendarRevision,
    producerRevisions: revisions as string[], calendar,
  };
}

/** A zone the runtime knows AND the shared bucket helper can convert exactly. */
function validZone(timeZone: string, atMs: number): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    localTimeBucket(new Date(atMs).toISOString(), timeZone);
    return true;
  } catch {
    return false;
  }
}

function parseTenantConfig(value: unknown): TenantConfigV2 | null {
  if (!isObject(value)) return null;
  const revoked = value.state === "revoked";
  if (!exactKeys(value, revoked ? [...CONFIG_KEYS, "revocationRef"] : CONFIG_KEYS)) return null;
  if (value.schemaVersion !== 1 || !isProducerRevision(value.configRevision)) return null;
  if (typeof value.source !== "string" || !(SOURCES as readonly string[]).includes(value.source)) return null;
  if (value.state !== "active" && !revoked) return null;
  if (revoked && (typeof value.revocationRef !== "string" || !REVOCATION_REF.test(value.revocationRef))) return null;
  const retention = parseTelemetryRetentionPolicy(value.retention);
  if (retention === null) return null;
  if (!Array.isArray(value.intervals) || value.intervals.length < 1 || value.intervals.length > MAX_TENANT_INTERVALS) return null;
  const intervals: TenantInterval[] = [];
  for (const raw of value.intervals) {
    const interval = parseInterval(raw);
    if (interval === null) return null;
    intervals.push(interval);
  }
  intervals.sort((a, b) => a.fromMs - b.fromMs);
  // Overlap would make the effective revision ambiguous. A gap is allowed in the setting but an
  // occurrence inside it resolves to nothing and is refused (see resolveInterval).
  for (let i = 1; i < intervals.length; i++) if (intervals[i]!.fromMs < intervals[i - 1]!.toMs) return null;
  if (new Set(intervals.map((interval) => interval.calendarRevision)).size !== intervals.length) return null;
  return {
    configRevision: value.configRevision, source: value.source as Source,
    state: revoked ? "revoked" : "active",
    revocationRef: revoked ? (value.revocationRef as string) : null,
    retention, intervals,
  };
}

/**
 * Strict parse of the whole setting. Any invalid tenant invalidates it all, and config revisions
 * must be unique across tenants so a revision names exactly one tenant's configuration.
 */
export function parseTenantConfigsV2(input: string | undefined): TenantConfigsV2 | null {
  if (input === undefined || input.length === 0 || input.length > MAX_CONFIG_BYTES) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { return null; }
  if (!isObject(decoded)) return null;
  const entries = Object.entries(decoded);
  if (entries.length === 0 || entries.length > 500) return null;
  const map = new Map<string, TenantConfigV2>();
  const revisions = new Set<string>();
  for (const [tenant, raw] of entries) {
    const config = TENANT_ID.test(tenant) ? parseTenantConfig(raw) : null;
    if (config === null || revisions.has(config.configRevision)) return null;
    revisions.add(config.configRevision);
    map.set(tenant, config);
  }
  return map;
}

/**
 * The configuration, validated against the tenant grants it must agree with. A configured tenant
 * with no grant, a different source, or an interval naming a producer revision the grant does not
 * approve is a conflict, and conflicting configuration authorizes nothing.
 */
export function resolveTenantConfigsV2(
  input: string | undefined,
  grants: TelemetryReceiverTenantsV2,
): TenantConfigsV2 | null {
  const configs = parseTenantConfigsV2(input);
  if (configs === null) return null;
  for (const [tenant, config] of configs) {
    const grant = grants.get(tenant);
    if (grant === undefined || grant.source !== config.source) return null;
    for (const interval of config.intervals) {
      if (!interval.producerRevisions.every((revision) => grant.producerRevisions.includes(revision))) return null;
    }
  }
  return configs;
}
