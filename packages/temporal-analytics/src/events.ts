/**
 * STRICT, CONTENT-FREE analytics events for OFFLINE and synthetic use.
 * This package has no transport, storage, Worker binding or automatic instrumentation.
 * Never put student identifiers, free text, case identifiers or message IDs in this schema.
 */
export const EVENT_KINDS = [
  "content_evaluated",
  "candidate_flagged",
  "report_received",
  "incident_opened",
  "review_queued",
  "review_completed",
  "protective_action",
  "incident_resolved",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const CATEGORIES = [
  "none", "harassment", "hate", "violence", "sexual", "self_harm",
  "privacy", "spam", "social_exclusion", "rumor", "moderation_abuse", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ["routine", "priority", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MODALITIES = ["text", "image", "mixed", "other"] as const;
export type Modality = (typeof MODALITIES)[number];

export const GRADE_BANDS = ["k5", "g6_8", "g9_12", "adult", "unspecified"] as const;
export type GradeBand = (typeof GRADE_BANDS)[number];

export const SOURCES = ["educateos", "playtrek", "hall_monitor"] as const;
export type Source = (typeof SOURCES)[number];

export const CALENDAR_KINDS = [
  "instructional", "weekend", "holiday", "break", "non_instructional", "unknown",
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/**
 * occurredAt denotes the stage's actual event time, not the time a dashboard receives it.
 * Different stages have different timestamps. All inputs must be explicit UTC ISO-8601.
 * gradeBand is coarse context, NEVER exact age. The calendar classification must be
 * supplied from the district-approved school calendar, not inferred from day-of-week.
 */
export interface TemporalMetricEvent {
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly kind: EventKind;
  readonly category: Category;
  readonly priority: Priority;
  readonly modality: Modality;
  readonly gradeBand: GradeBand;
  readonly source: Source;
  readonly calendarKind: CalendarKind;
  /** Only for review_completed; never a student ID or event payload. */
  readonly reviewLatencyMs?: number;
}

const REQUIRED = [
  "schemaVersion", "occurredAt", "kind", "category", "priority",
  "modality", "gradeBand", "source", "calendarKind",
] as const;
const ALLOWED = new Set<string>([...REQUIRED, "reviewLatencyMs"]);
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/**
 * Strict runtime admission: an unexpected field (notably raw text or a student ID)
 * makes the entire event invalid. Unknown category/provider strings never become
 * user-controlled analytics dimensions.
 */
export function parseTemporalMetricEvent(value: unknown): TemporalMetricEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("temporal metric must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) throw new TypeError("unsupported temporal metric field");
  }
  for (const key of REQUIRED) {
    if (!Object.hasOwn(record, key)) throw new TypeError("missing temporal metric field");
  }
  if (record.schemaVersion !== 1) throw new TypeError("unsupported temporal schema version");
  if (typeof record.occurredAt !== "string" || !UTC_ISO.test(record.occurredAt)) {
    throw new TypeError("temporal event time must be UTC ISO-8601 with Z");
  }
  const date = new Date(record.occurredAt);
  if (!Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== record.occurredAt.slice(0, 19)) {
    throw new TypeError("invalid temporal event timestamp");
  }
  if (!oneOf(EVENT_KINDS, record.kind) ||
      !oneOf(CATEGORIES, record.category) ||
      !oneOf(PRIORITIES, record.priority) ||
      !oneOf(MODALITIES, record.modality) ||
      !oneOf(GRADE_BANDS, record.gradeBand) ||
      !oneOf(SOURCES, record.source) ||
      !oneOf(CALENDAR_KINDS, record.calendarKind)) {
    throw new TypeError("invalid temporal metric enumeration");
  }
  if (record.reviewLatencyMs !== undefined) {
    if (record.kind !== "review_completed" ||
        typeof record.reviewLatencyMs !== "number" ||
        !Number.isFinite(record.reviewLatencyMs) ||
        record.reviewLatencyMs < 0 || record.reviewLatencyMs > 7 * 86400000) {
      throw new TypeError("invalid review latency");
    }
  }
  return record as unknown as TemporalMetricEvent;
}
