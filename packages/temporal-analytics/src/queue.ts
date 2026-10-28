/**
 * Synthetic/offline staffing queue model. No identities, content, incidents or network.
 * Minute coordinates represent elapsed UTC minutes from a caller-defined simulation start;
 * the institutional calendar and DST/shift schedule must be converted before simulation.
 * Non-preemptive work can finish after a scheduled shift. Not a duty-of-care guarantee.
 */
export type ReviewPriority = "urgent" | "priority" | "routine";

export interface SyntheticReviewArrival {
  readonly atMinute: number;
  readonly serviceMinutes: number;
  readonly priority: ReviewPriority;
}

export interface ReviewerCapacityShift {
  readonly fromMinute: number;
  readonly toMinute: number;
  readonly reviewers: number;
}

export interface QueueSimulationResult {
  readonly arrivals: number;
  readonly started: number;
  readonly completed: number;
  /** Unstarted and in-progress jobs at the horizon. */
  readonly pending: number;
  readonly unstartedUrgent: number;
  readonly maxWaiting: number;
  /** Among started jobs only; pending jobs are right-censored and must be shown separately. */
  readonly p50WaitMinutes: number | null;
  readonly p95WaitMinutes: number | null;
  readonly maxWaitMinutes: number | null;
  readonly p95UrgentWaitMinutes: number | null;
}

interface WaitingJob extends SyntheticReviewArrival {
  readonly index: number;
}

function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * q) - 1]!;
}

const PRIORITY_ORDER: Readonly<Record<ReviewPriority, number>> = {
  urgent: 0, priority: 1, routine: 2,
};

function validNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Deterministic, minute-stepped, FIFO within urgency class.
 * Earlier arrivals are admitted, then active work completes, then staff pick the
 * highest-priority waiting job. Active jobs are never preempted. Only synthetic
 * workloads should be passed; real incident triage is a separate reviewed system.
 */
export function simulateReviewQueue(
  arrivals: readonly SyntheticReviewArrival[],
  shifts: readonly ReviewerCapacityShift[],
  horizonMinutes: number,
): QueueSimulationResult {
  if (!Number.isSafeInteger(horizonMinutes) || horizonMinutes < 0 ||
      horizonMinutes > 60 * 24 * 31) {
    throw new RangeError("horizon must be 0..31 days in minutes");
  }
  for (const arrival of arrivals) {
    if (!validNonnegative(arrival.atMinute) ||
        !Number.isSafeInteger(arrival.serviceMinutes) || arrival.serviceMinutes < 1 ||
        !Object.hasOwn(PRIORITY_ORDER, arrival.priority) ||
        arrival.atMinute > horizonMinutes) {
      throw new RangeError("invalid synthetic review task");
    }
  }
  for (const shift of shifts) {
    if (!validNonnegative(shift.fromMinute) || !validNonnegative(shift.toMinute) ||
        shift.toMinute <= shift.fromMinute ||
        shift.toMinute > horizonMinutes ||
        !validNonnegative(shift.reviewers) || shift.reviewers > 10000) {
      throw new RangeError("invalid reviewer capacity shift");
    }
  }

  const due: WaitingJob[] = arrivals
    .map((a, index) => ({ ...a, index }))
    .sort((a, b) => a.atMinute - b.atMinute || a.index - b.index);
  const waiting: WaitingJob[] = [];
  const active: Array<{ finish: number }> = [];
  const waitTimes: number[] = [];
  const urgentWaitTimes: number[] = [];
  let cursor = 0, started = 0, completed = 0, maxWaiting = 0;

  for (let minute = 0; minute <= horizonMinutes; minute++) {
    while (cursor < due.length && due[cursor]!.atMinute <= minute) {
      waiting.push(due[cursor]!);
      cursor++;
    }
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.finish <= minute) {
        active.splice(i, 1);
        completed++;
      }
    }
    // Overlapping shifts contribute their available simultaneous reviewer count.
    const capacity = shifts.reduce((total, shift) =>
      total + (minute >= shift.fromMinute && minute < shift.toMinute ? shift.reviewers : 0), 0);
    while (active.length < capacity && waiting.length > 0) {
      waiting.sort((a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        a.atMinute - b.atMinute || a.index - b.index);
      const next = waiting.shift()!;
      const wait = minute - next.atMinute;
      waitTimes.push(wait);
      if (next.priority === "urgent") urgentWaitTimes.push(wait);
      active.push({ finish: minute + next.serviceMinutes });
      started++;
    }
    maxWaiting = Math.max(maxWaiting, waiting.length);
  }

  return {
    arrivals: arrivals.length, started, completed,
    pending: arrivals.length - completed,
    unstartedUrgent: waiting.filter((task) => task.priority === "urgent").length,
    maxWaiting,
    p50WaitMinutes: percentile(waitTimes, 0.5),
    p95WaitMinutes: percentile(waitTimes, 0.95),
    maxWaitMinutes: waitTimes.length === 0 ? null : Math.max(...waitTimes),
    p95UrgentWaitMinutes: percentile(urgentWaitTimes, 0.95),
  };
}
