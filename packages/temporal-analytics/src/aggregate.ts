import {
  parseTemporalMetricEvent,
  type CalendarKind, type GradeBand, type Source, type TemporalMetricEvent,
} from "./events.ts";
import { localTimeBucket } from "./bucket.ts";

/** Exact offline counts, NOT a case ledger. Source must dedupe before aggregation. */
export interface HourOfWeekCell {
  readonly source: Source;
  readonly gradeBand: GradeBand;
  readonly calendarKind: CalendarKind;
  readonly weekday: number;
  readonly hour: number;
  readonly evaluated: number;
  readonly candidates: number;
  readonly reports: number;
  readonly incidentsOpened: number;
  readonly reviewsQueued: number;
  readonly reviewsCompleted: number;
  readonly protectiveActions: number;
  readonly incidentsResolved: number;
  readonly reviewLatencySumMs: number;
  readonly reviewLatencySamples: number;
}

type MutableCell = { -readonly [K in keyof HourOfWeekCell]: HourOfWeekCell[K] };

function fresh(event: TemporalMetricEvent, weekday: number, hour: number): MutableCell {
  return {
    source: event.source, gradeBand: event.gradeBand, calendarKind: event.calendarKind,
    weekday, hour, evaluated: 0, candidates: 0, reports: 0,
    incidentsOpened: 0, reviewsQueued: 0, reviewsCompleted: 0,
    protectiveActions: 0, incidentsResolved: 0,
    reviewLatencySumMs: 0, reviewLatencySamples: 0,
  };
}

/**
 * Aggregates validated, locally-authorized, already-deduplicated synthetic events into
 * a 168-cell week-of-time pattern per coarse source/band/calendar cohort.
 *
 * The function does NOT collect from school chat or publish cross-district analytics.
 * An empty bucket means "no observed events", NOT "operationally healthy with zero events":
 * use a separate ingestion coverage/calendar table for that distinction.
 *
 * Caveat: event-specific categories are deliberately not dimensions in this public-safe
 * baseline; category drilldowns require separate privacy assessment and denominators.
 */
export function aggregateHourOfWeek(
  input: readonly unknown[],
  institutionTimeZone: string,
): HourOfWeekCell[] {
  const cells = new Map<string, MutableCell>();
  for (const raw of input) {
    const event = parseTemporalMetricEvent(raw);
    const bucket = localTimeBucket(event.occurredAt, institutionTimeZone);
    const key = [event.source, event.gradeBand, event.calendarKind,
      bucket.weekday, bucket.localHour].join("|");
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = fresh(event, bucket.weekday, bucket.localHour);
      cells.set(key, cell);
    }
    switch (event.kind) {
      case "content_evaluated": cell.evaluated++; break;
      case "candidate_flagged": cell.candidates++; break;
      case "report_received": cell.reports++; break;
      case "incident_opened": cell.incidentsOpened++; break;
      case "review_queued": cell.reviewsQueued++; break;
      case "review_completed":
        cell.reviewsCompleted++;
        if (event.reviewLatencyMs !== undefined) {
          cell.reviewLatencySamples++;
          cell.reviewLatencySumMs += event.reviewLatencyMs;
        }
        break;
      case "protective_action": cell.protectiveActions++; break;
      case "incident_resolved": cell.incidentsResolved++; break;
    }
  }
  return [...cells.values()].sort((a, b) =>
    a.source.localeCompare(b.source) ||
    a.gradeBand.localeCompare(b.gradeBand) ||
    a.calendarKind.localeCompare(b.calendarKind) ||
    a.weekday - b.weekday || a.hour - b.hour);
}

/** Caller must use the same source, cohort, time window and calendar coverage. */
export function flagRatePerThousand(cell: HourOfWeekCell): number | null {
  if (cell.evaluated === 0) return null;
  if (cell.candidates > cell.evaluated) {
    // One candidate flag per evaluated submission is a source-system invariant.
    throw new RangeError("candidate count exceeds evaluated denominator");
  }
  return (1000 * cell.candidates) / cell.evaluated;
}

/**
 * Defensive display gate for an individual aggregate cell.
 * NOT a formal anonymity guarantee; cross-district export, overlap differencing,
 * small cohorts and cumulative disclosures need independent privacy controls.
 */
export function suppressRareCell(
  cell: HourOfWeekCell,
  minEvaluated = 20,
  minNonzeroOutcome = 5,
): HourOfWeekCell | null {
  if (!Number.isInteger(minEvaluated) || minEvaluated < 1 ||
      !Number.isInteger(minNonzeroOutcome) || minNonzeroOutcome < 1) {
    throw new RangeError("invalid suppression thresholds");
  }
  if (cell.evaluated < minEvaluated) return null;
  const outcomes = [
    cell.candidates, cell.reports, cell.incidentsOpened, cell.reviewsQueued,
    cell.reviewsCompleted, cell.protectiveActions, cell.incidentsResolved,
  ];
  if (outcomes.some((n) => n > 0 && n < minNonzeroOutcome)) return null;
  return cell;
}

/** WAE sampling requires per-row _sample_interval weighting; never use COUNT(). */
export function weightedAnalyticsEngineCount(sampleIntervals: readonly number[]): number {
  let total = 0;
  for (const interval of sampleIntervals) {
    if (!Number.isSafeInteger(interval) || interval < 1) {
      throw new RangeError("invalid Analytics Engine sample interval");
    }
    total += interval;
    if (!Number.isSafeInteger(total)) throw new RangeError("weighted sample count overflow");
  }
  return total;
}
