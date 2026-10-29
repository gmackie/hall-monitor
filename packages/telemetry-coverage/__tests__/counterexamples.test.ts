import { describe, expect, it } from "vitest";
import { applyEvidence, emptyEvidence, summarizeEvidence } from "../src/index.ts";
import { checkpoint, delivery, SCOPE } from "./fixtures.ts";
import {
  clampCountValidity, committedThrough, completionLedger, oracleCountAvailability, oracleCounts,
  type SyntheticCompletion, type SyntheticCountWitness,
} from "./oracle.ts";

const completion = (sequence: number, over: Partial<SyntheticCompletion> = {}): SyntheticCompletion => ({
  completionId: `synthetic-completion-${sequence}`, scope: SCOPE, sequence,
  occurredAt: 0.5, commitOrder: sequence, committedAt: sequence, candidate: false, ...over,
});

// Rejected hypotheses from the proposal. Kept ONLY in tests to demonstrate their disagreement.
const rejectedZero = (spanLive: boolean, rollupVisible: boolean, gapOverlaps: boolean) => spanLive && !rollupVisible && !gapOverlaps;
const rejectedRegression = (accounted: number, presence: number) => accounted < presence;
const rejectedFrontier = (allAckedOrDeclared: boolean, commitTimeOfS: number, through: number) => allAckedOrDeclared && commitTimeOfS <= through;
const rejectedFinal = (armedSince: number, bucketStart: number, bucketEnd: number, fence: number, through: number, now: number, verified: boolean, taint: boolean) =>
  armedSince <= bucketStart - fence && through >= bucketEnd + fence && verified && !taint && now >= bucketEnd;

describe("explicit witnesses against rejected coverage rules", () => {
  it("C1: retained coverage makes an expired nonzero bucket indistinguishable from empty", () => {
    const nonzero = completionLedger([completion(1)]);
    const empty = completionLedger([]);
    const deadlines = { rollup: 10, coverage: 20, gap: 30 };
    expect(deadlines.rollup <= deadlines.coverage && deadlines.coverage <= deadlines.gap).toBe(true);
    const now = 11;
    const projectReceiverView = (ledger: readonly SyntheticCompletion[]) => ({
      spanLive: now < deadlines.coverage,
      rollupVisible: now < deadlines.rollup,
      gapOverlaps: false,
      rollup: now < deadlines.rollup ? oracleCounts(ledger, SCOPE, 0, 1) : null,
    });
    const receiverView = projectReceiverView(nonzero);
    expect(rejectedZero(receiverView.spanLive, receiverView.rollupVisible, receiverView.gapOverlaps)).toBe(true);
    expect(oracleCounts(nonzero, SCOPE, 0, 1).evaluated).toBe(1);
    expect(oracleCounts(empty, SCOPE, 0, 1).evaluated).toBe(0);
    expect(oracleCountAvailability({ deadline: 10, deleted: false, revoked: false }, now)).toBe("expired");
    expect(projectReceiverView(nonzero)).toEqual(projectReceiverView(empty));
  });

  it("C2: a legitimate delayed checkpoint or lost ack is not a rollback", () => {
    const ledger = completionLedger(Array.from({ length: 10 }, (_, i) => completion(i + 1)));
    let state = Array.from({ length: 10 }, (_, i) => delivery(i + 1)).reduce(applyEvidence, emptyEvidence());
    expect(oracleCounts(ledger, SCOPE, 0, 1).evaluated).toBe(10);
    for (const fact of [checkpoint(5, 5), checkpoint(6, 5)]) {
      const before = summarizeEvidence(state, SCOPE);
      expect(before.kind).toBe("observed");
      if (before.kind !== "observed") throw new Error("unexpected capacity");
      expect(rejectedRegression(fact.accountedSequence, before.contiguousSequence)).toBe(true);
      state = applyEvidence(state, fact);
      expect(summarizeEvidence(state, SCOPE)).toMatchObject({ conflicts: [], contiguousSequence: 10 });
      expect(applyEvidence(state, fact)).toBe(state);
    }
  });

  it.each([false, true])("C3: a delivered sequence prefix omits a committed time prefix (equal clocks: %s)", (equalClock) => {
    const ledger = completionLedger([
      completion(1, { committedAt: 1 }), completion(2, { committedAt: equalClock ? 1 : 2, candidate: true }),
    ]);
    const through = 3;
    const accountedSequence = 1;
    const acked = new Set([1]);
    const everySequenceUpToS = Array.from({ length: accountedSequence }, (_, i) => i + 1).every((s) => acked.has(s));
    expect(rejectedFrontier(everySequenceUpToS, ledger[0]!.committedAt, through)).toBe(true);
    expect(committedThrough(ledger, SCOPE, through).every((entry) => entry.sequence <= accountedSequence)).toBe(false);
    expect(committedThrough(ledger, SCOPE, through).map((e) => e.sequence)).toEqual([1, 2]);
    expect(oracleCounts(ledger, SCOPE, 0, 1, through)).toEqual({ evaluated: 2, candidate: 1 });
  });

  it("C4: a fence violation after a claimed final zero changes the eventual bucket", () => {
    const prepared = { occurrence: 0.5, preparedAt: 0.5 };
    const receiverPrefix = { armedSince: -1, bucketStart: 0, bucketEnd: 1, fence: 1, through: 2, receiverNow: 2, accounted: [], taint: [] };
    const oldFinal = rejectedFinal(-1, 0, 1, 1, 2, 2, true, false);
    expect(oldFinal).toBe(true);
    const noCompletionSuffix = completionLedger([]);
    const delayedCompletionSuffix = completionLedger([completion(1, { occurredAt: prepared.occurrence, committedAt: 3 })]);
    // Up to the receiver's observation cut, both histories expose exactly the same facts.
    expect(committedThrough(noCompletionSuffix, SCOPE, 2)).toEqual(committedThrough(delayedCompletionSuffix, SCOPE, 2));
    const projectObservedPrefix = (ledger: readonly SyntheticCompletion[]) => ({
      accounted: committedThrough(ledger, SCOPE, receiverPrefix.through).map((entry) => entry.sequence),
      fenceGaps: committedThrough(ledger, SCOPE, receiverPrefix.through)
        .filter((entry) => entry.committedAt > entry.occurredAt + receiverPrefix.fence).map((entry) => entry.sequence),
    });
    expect(projectObservedPrefix(noCompletionSuffix)).toEqual({ accounted: [], fenceGaps: [] });
    expect(projectObservedPrefix(delayedCompletionSuffix)).toEqual(projectObservedPrefix(noCompletionSuffix));
    expect(oracleCounts(noCompletionSuffix, SCOPE, 0, 1)).toEqual({ evaluated: 0, candidate: 0 });
    expect(oracleCounts(delayedCompletionSuffix, SCOPE, 0, 1)).toEqual({ evaluated: 1, candidate: 0 });
    const laterCheckpoint = { historicalFenceGap: [0, 1], committedAt: 3, receivedAt: 4 };
    expect(laterCheckpoint.receivedAt).toBeGreaterThan(receiverPrefix.through);
    expect(delayedCompletionSuffix[0]!.committedAt > prepared.preparedAt + receiverPrefix.fence).toBe(true);
  });
});

describe("independent count validity and fixture admission", () => {
  it("T1: read-time expiry, alarm deletion and restart cannot resurrect counts under long→short→long", () => {
    const initial: SyntheticCountWitness = { deadline: 30, deleted: false, revoked: false };
    const short = clampCountValidity(initial, 10);
    const restored = JSON.parse(JSON.stringify(short)) as SyntheticCountWitness;
    const long = clampCountValidity(restored, 40);
    expect(long.deadline).toBe(10);
    expect(oracleCountAvailability(long, 9)).toBe("available");
    expect(oracleCountAvailability(long, 10)).toBe("expired");
    const alarmDeleted = { ...long, deleted: true };
    expect(oracleCountAvailability(alarmDeleted, 11)).toBe("expired");
    expect(oracleCountAvailability(clampCountValidity(alarmDeleted, 50), 12)).toBe("expired");
    expect(clampCountValidity(initial, 40).deadline).toBe(30);
    expect(oracleCountAvailability(null, 1)).toBe("unknown");
  });

  it("T1: revoked evidence remains revoked; re-enrollment needs a distinct scope", () => {
    const revoked: SyntheticCountWitness = { deadline: 30, deleted: true, revoked: true };
    expect(oracleCountAvailability(revoked, 1)).toBe("revoked");
    const old = completion(1);
    const nextScope = { ...SCOPE, epoch: "re-enrolled" };
    const ledger = completionLedger([old, completion(1, { scope: nextScope, completionId: "new-completion" })]);
    expect(oracleCounts(ledger, SCOPE, 0, 1).evaluated).toBe(1);
    expect(oracleCounts(ledger, nextScope, 0, 1).evaluated).toBe(1);
    expect(oracleCountAvailability(null, 1)).toBe("unknown");
  });

  it.each([
    [completion(1), completion(2, { completionId: "synthetic-completion-1" })],
    [completion(1), completion(1, { completionId: "another" })],
    [completion(2)], [completion(1, { commitOrder: 0 })], [completion(1, { sequence: 1.5 })],
    [completion(1, { occurredAt: NaN })], [completion(1, { committedAt: Infinity })],
    [completion(1), completion(2, { commitOrder: 1 })],
    [completion(1, { committedAt: 2 }), completion(2, { committedAt: 1 })],
  ])("B1: rejects malformed or contradictory completion fixtures %j", (...entries) => {
    expect(() => completionLedger(entries)).toThrow(TypeError);
  });

  it("is immutable and counts undelivered and fence-violating completions independently of evidence", () => {
    const input = completion(1, { committedAt: 20, candidate: true });
    const ledger = completionLedger([input]);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger[0])).toBe(true);
    expect(oracleCounts(ledger, SCOPE, 0, 1)).toEqual({ evaluated: 1, candidate: 1 });
    expect(oracleCounts(ledger, SCOPE, 0, 1, 19)).toEqual({ evaluated: 0, candidate: 0 });
  });
});
