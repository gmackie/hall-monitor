import { describe, expect, it } from "vitest";
import {
  parseTemporalMetricEvent, localTimeBucket, aggregateHourOfWeek,
  flagRatePerThousand, suppressRareCell, weightedAnalyticsEngineCount,
  estimateCapacity, positivePredictiveValue,
} from "../src/index.ts";
import type { EventKind, TemporalMetricEvent, HourOfWeekCell } from "../src/index.ts";

function metric(kind: EventKind, occurredAt = "2026-10-28T14:00:00Z"): TemporalMetricEvent {
  return {
    schemaVersion: 1, kind, occurredAt, category: "none", priority: "routine",
    modality: "text", gradeBand: "g9_12", source: "educateos",
    calendarKind: "instructional",
  };
}

describe("content-free admission", () => {
  it("accepts the fixed, versioned schema", () => {
    expect(parseTemporalMetricEvent(metric("content_evaluated")).kind).toBe("content_evaluated");
  });
  it("rejects student identifiers, message text and unbounded free strings", () => {
    expect(() => parseTemporalMetricEvent({ ...metric("content_evaluated"), studentId: "123" })).toThrow();
    expect(() => parseTemporalMetricEvent({ ...metric("content_evaluated"), text: "hey" })).toThrow();
    expect(() => parseTemporalMetricEvent({ ...metric("candidate_flagged"), category: "student-alex" })).toThrow();
    expect(() => parseTemporalMetricEvent({ ...metric("candidate_flagged"), policyRevision: "message body" })).toThrow();
  });
  it("enforces real UTC timestamps, not attacker-supplied naive local values", () => {
    expect(() => parseTemporalMetricEvent({ ...metric("content_evaluated"), occurredAt: "2026-10-28T10:00:00-04:00" })).toThrow();
    expect(() => parseTemporalMetricEvent({ ...metric("content_evaluated"), occurredAt: "2026-02-30T00:00:00Z" })).toThrow();
  });
  it("allows review latency only on completed review and bounds it", () => {
    expect(() => parseTemporalMetricEvent({ ...metric("content_evaluated"), reviewLatencyMs: 4 })).toThrow();
    expect(() => parseTemporalMetricEvent({ ...metric("review_completed"), reviewLatencyMs: Infinity })).toThrow();
    expect(parseTemporalMetricEvent({ ...metric("review_completed"), reviewLatencyMs: 2400 }).reviewLatencyMs).toBe(2400);
  });
});

describe("local institutional clocks and DST", () => {
  it("distinguishes the two fall-back 1 AM hours", () => {
    const first = localTimeBucket("2026-11-01T05:30:00Z", "America/Detroit");
    const second = localTimeBucket("2026-11-01T06:30:00Z", "America/Detroit");
    expect(first.localDate).toBe("2026-11-01");
    expect(first.localHour).toBe(1);
    expect(second.localHour).toBe(1);
    expect([first.utcOffsetMinutes, second.utcOffsetMinutes]).toEqual([-240, -300]);
    expect(first.hourOfWeek).toBe(second.hourOfWeek);
  });
  it("skips the non-existent spring-forward 2 AM", () => {
    expect(localTimeBucket("2026-03-08T06:30:00Z", "America/Detroit").localHour).toBe(1);
    expect(localTimeBucket("2026-03-08T07:30:00Z", "America/Detroit").localHour).toBe(3);
  });
  it("does not confuse UTC calendar day with U.S. local day", () => {
    const west = localTimeBucket("2026-10-28T04:30:00Z", "America/Los_Angeles");
    expect(west.localDate).toBe("2026-10-27");
    expect(west.localHour).toBe(21);
    expect(west.weekday).toBe(1);
    expect(west.weekStartingMonday).toBe("2026-10-26");
  });
  it("rejects unknown time zones", () => {
    expect(() => localTimeBucket("2026-10-28T14:00:00Z", "somewhere/fake")).toThrow();
  });
});

describe("hour-of-week synthetic aggregation", () => {
  it("counts stages independently, with a denominator for flag rates", () => {
    const at = "2026-10-28T14:00:00Z";
    const rows = aggregateHourOfWeek([
      metric("content_evaluated", at), metric("content_evaluated", at),
      metric("candidate_flagged", at), metric("report_received", at),
      { ...metric("review_completed", at), reviewLatencyMs: 2500 },
    ], "America/Detroit");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.hour).toBe(10);
    expect(row.weekday).toBe(2);
    expect(row.evaluated).toBe(2);
    expect(row.candidates).toBe(1);
    expect(row.reports).toBe(1);
    expect(row.reviewLatencySamples).toBe(1);
    expect(row.reviewLatencySumMs).toBe(2500);
    expect(flagRatePerThousand(row)).toBe(500);
  });
  it("aggregates repeated DST hours without claiming exactly 168 real hours", () => {
    const rows = aggregateHourOfWeek([
      metric("content_evaluated", "2026-11-01T05:30:00Z"),
      metric("content_evaluated", "2026-11-01T06:30:00Z"),
    ], "America/Detroit");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evaluated).toBe(2);
    expect(rows[0]!.hour).toBe(1);
  });
  it("handles missing denominators and catches broken event invariants", () => {
    const base = aggregateHourOfWeek([metric("candidate_flagged")], "America/Detroit")[0]!;
    expect(flagRatePerThousand(base)).toBeNull();
    expect(() => flagRatePerThousand({ ...base, evaluated: 1, candidates: 2 })).toThrow();
  });
  it("suppresses sparse slices (not a formal anonymization guarantee)", () => {
    const base = aggregateHourOfWeek([metric("content_evaluated")], "America/Detroit")[0]!;
    const populated: HourOfWeekCell = { ...base, evaluated: 30, candidates: 5 };
    expect(suppressRareCell(base)).toBeNull();
    expect(suppressRareCell({ ...populated, candidates: 2 })).toBeNull();
    expect(suppressRareCell(populated)).toEqual(populated);
    expect(() => suppressRareCell(populated, 0)).toThrow();
  });
  it("weights Analytics Engine sampling rather than counting rows", () => {
    expect(weightedAnalyticsEngineCount([1, 5, 10])).toBe(16);
    expect(() => weightedAnalyticsEngineCount([1, 0])).toThrow();
  });
});

describe("capacity math (illustrative only)", () => {
  it("keeps model and labor money in integer nanodollars", () => {
    const out = estimateCapacity({
      monthlyMessages: 1_000_000, routedFraction: 0.15,
      inputTokensPerRoutedMessage: 600, modelPriceNanoPerMillion: 38_000_000n,
      humanReviewFraction: 0.0013, averageReviewSeconds: 90,
      humanHourlyPriceNano: 35_000_000_000n,
    });
    expect(out.routedMessages).toBe(150_000);
    expect(out.inputTokens).toBe(90_000_000n);
    expect(out.modelCostUsdNano).toBe(3_420_000_000n);
    expect(out.humanReviews).toBe(1300);
    expect(out.humanCostUsdNano).toBe(1_137_500_000_000n);
  });
  it("demonstrates the base-rate problem without creating a student risk score", () => {
    expect(positivePredictiveValue(0.001, 0.95, 0.99)).toBeCloseTo(0.0869, 3);
    expect(positivePredictiveValue(0, 0, 1)).toBeNull();
    expect(() => positivePredictiveValue(-1, 0.9, 0.9)).toThrow();
  });
});
