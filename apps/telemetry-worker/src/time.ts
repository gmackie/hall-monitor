import { localTimeBucket, type CalendarKind } from "@gmacko/hall-monitor-temporal-analytics";

/**
 * Exact occurrence buckets are 15 UTC minutes. That is the finest unit every real UTC offset
 * (including :30 and :45 zones) shares, so local hours derive from these rows exactly. Nothing here
 * is a date-free weekday/hour grouping.
 */
export const BUCKET_MS = 15 * 60 * 1000;

export function bucketStartOf(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/** An inclusive local-date range with an explicit district classification. */
export interface CalendarSpan {
  readonly from: string;
  readonly to: string;
  readonly kind: CalendarKind;
}

/**
 * One effective period of a tenant's trusted configuration. Both ends sit on a bucket boundary, so
 * a 15-minute bucket is never split between two revisions.
 */
export interface TenantInterval {
  readonly fromMs: number;
  readonly toMs: number;
  readonly timeZone: string;
  readonly calendarRevision: string;
  readonly producerRevisions: readonly string[];
  readonly calendar: readonly CalendarSpan[];
}

/** The trusted dimensions pinned to a bucket from the revision that was effective at its occurrence. */
export interface TrustedDimensions {
  readonly configRevision: string;
  readonly calendarRevision: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly localHour: number;
  /** Monday=0 to Sunday=6. */
  readonly weekday: number;
  readonly weekStartingMonday: string;
  readonly utcOffsetMinutes: number;
  /** From the district calendar only. A date it does not classify stays "unknown". */
  readonly calendarKind: CalendarKind;
}

/** The interval whose half-open range contains `ms`, or null when nothing is configured for it. */
export function resolveInterval(intervals: readonly TenantInterval[], ms: number): TenantInterval | null {
  return intervals.find((interval) => interval.fromMs <= ms && ms < interval.toMs) ?? null;
}

export function classifyLocalDate(calendar: readonly CalendarSpan[], localDate: string): CalendarKind {
  return calendar.find((span) => span.from <= localDate && localDate <= span.to)?.kind ?? "unknown";
}

/**
 * Local dimensions for the bucket starting at `bucketStartMs`, in the interval's zone and calendar.
 * Reuses the shared bucket helper; a UTC-to-local conversion never goes through the date-free
 * 168-cell projection. Throws if the bucket is not wholly inside one local hour and one offset
 * (it would otherwise mix data from two local hours into one row), or if the zone cannot be
 * converted exactly. The caller refuses such an occurrence; it is never assigned a guess.
 */
export function deriveTrustedDimensions(
  configRevision: string,
  interval: TenantInterval,
  bucketStartMs: number,
): TrustedDimensions {
  const first = localTimeBucket(new Date(bucketStartMs).toISOString(), interval.timeZone);
  const last = localTimeBucket(new Date(bucketStartMs + BUCKET_MS - 1).toISOString(), interval.timeZone);
  if (first.localDate !== last.localDate || first.localHour !== last.localHour ||
      first.utcOffsetMinutes !== last.utcOffsetMinutes) {
    throw new TypeError("bucket spans more than one local hour or offset");
  }
  return {
    configRevision,
    calendarRevision: interval.calendarRevision,
    timeZone: interval.timeZone,
    localDate: first.localDate,
    localHour: first.localHour,
    weekday: first.weekday,
    weekStartingMonday: first.weekStartingMonday,
    utcOffsetMinutes: first.utcOffsetMinutes,
    calendarKind: classifyLocalDate(interval.calendar, first.localDate),
  };
}
