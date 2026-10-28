import { describe, expect, it } from "vitest";
import { simulateReviewQueue } from "../src/queue.ts";

describe("synthetic staffing queue", () => {
  it("starts urgent work before routine work at the same arrival time", () => {
    const result = simulateReviewQueue(
      [
        { atMinute: 540, priority: "routine", serviceMinutes: 10 },
        { atMinute: 540, priority: "urgent", serviceMinutes: 10 },
      ],
      [{ fromMinute: 540, toMinute: 580, reviewers: 1 }],
      600,
    );
    expect(result.started).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.p95UrgentWaitMinutes).toBe(0);
    expect(result.p95WaitMinutes).toBe(10);
  });

  it("makes after-hours staffing absence visible rather than pretending 24/7 coverage", () => {
    const overnight = { atMinute: 1200, priority: "urgent" as const, serviceMinutes: 15 };
    const schoolHours = simulateReviewQueue(
      [overnight],
      [{ fromMinute: 1980, toMinute: 2040, reviewers: 1 }],
      2100,
    );
    expect(schoolHours.p95UrgentWaitMinutes).toBe(780);
    expect(schoolHours.completed).toBe(1);
    const staffed = simulateReviewQueue(
      [overnight],
      [{ fromMinute: 0, toMinute: 2100, reviewers: 1 }],
      2100,
    );
    expect(staffed.p95UrgentWaitMinutes).toBe(0);
  });

  it("distinguishes pending/censored cases from completed ones", () => {
    const result = simulateReviewQueue(
      [
        { atMinute: 5, priority: "urgent", serviceMinutes: 100 },
        { atMinute: 6, priority: "routine", serviceMinutes: 3 },
      ],
      [{ fromMinute: 0, toMinute: 20, reviewers: 1 }],
      20,
    );
    expect(result.arrivals).toBe(2);
    expect(result.started).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.pending).toBe(2);
    expect(result.maxWaiting).toBe(1);
    expect(result.unstartedUrgent).toBe(0);
  });

  it("rejects malformed and unbounded workloads", () => {
    expect(() => simulateReviewQueue(
      [{ atMinute: 0, serviceMinutes: 5, priority: "routine" }],
      [{ fromMinute: 0, toMinute: 100, reviewers: -1 }],
      100,
    )).toThrow();
    expect(() => simulateReviewQueue(
      [{ atMinute: 0, serviceMinutes: 5, priority: "nonsense" as never }],
      [], 100,
    )).toThrow();
    expect(() => simulateReviewQueue([], [], -1)).toThrow();
  });
});
