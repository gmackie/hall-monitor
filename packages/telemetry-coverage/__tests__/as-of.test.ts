import { describe, expect, it } from "vitest";
import { EVALUATED_VOLUME_MEMBERSHIP_REVISION, advanceProposedAsOfClock, applyProposedAsOfFact, clampProposedCountDeadline, createProposedAsOf,
  invalidateProposedCountsBefore, readProposedAsOf, revokeProposedAsOf, type ProposedAsOfFact, type ProposedAsOfScope } from "../src/index.ts";
import { completionLedger, oracleCounts, type SyntheticCompletion } from "./oracle.ts";

const scope: ProposedAsOfScope = { tenant: "synthetic-tenant", streamId: "synthetic-stream", epoch: "epoch-1", membershipRevision: EVALUATED_VOLUME_MEMBERSHIP_REVISION };
const digest = (n: number) => n.toString(16).padStart(64, "0");
const completion = (sequence: number, bucket = 10, candidate = false): ProposedAsOfFact => ({ kind: "completion", sequence, completionId: `completion-${sequence}`, digest: digest(sequence), occurrenceBucket: bucket, candidate });
const checkpoint = (throughSequence: number, checkpointId = 1): ProposedAsOfFact => ({ kind: "checkpoint", checkpointId, digest: digest(1000 + checkpointId), throughSequence });
const query = { scope, checkpointId: 1, startBucket: 10, endBucket: 11 };
function state(facts: readonly ProposedAsOfFact[]) { return facts.reduce(applyProposedAsOfFact, createProposedAsOf(scope, 100, 0)); }

describe("qualified logical-cut model, not runtime coverage", () => {
  it("reaches exact nonzero and genuine scoped zero under explicit source cut assumptions", () => {
    const exact = readProposedAsOf(state([completion(1, 10, true), completion(2, 9), checkpoint(2)]), query);
    expect(exact).toMatchObject({ status: "scoped-as-of-model", throughSequence: 2, evaluated: 1, candidate: 1, final: false, runtimeApproved: false });
    expect(readProposedAsOf(state([checkpoint(0)]), query)).toMatchObject({ status: "scoped-as-of-model", evaluated: 0, candidate: 0 });
    expect(readProposedAsOf(state([]), query)).toEqual({ status: "unavailable", reason: "checkpoint-unknown" });
  });

  it("does not shrink E to deliveries: every undelivered source commit prevents an exact claim", () => {
    const ledger = completionLedger(Array.from({ length: 4 }, (_, i): SyntheticCompletion => ({ completionId: `completion-${i + 1}`, scope,
      sequence: i + 1, occurredAt: 10, committedAt: 20, commitOrder: i + 1, candidate: i === 0 })));
    expect(oracleCounts(ledger, scope, 10, 11)).toEqual({ evaluated: 4, candidate: 1 });
    for (let missing = 1; missing <= 4; missing++) {
      const facts = [1, 2, 3, 4].filter((n) => n !== missing).map((n) => completion(n, 10, n === 1));
      expect(readProposedAsOf(state([...facts, checkpoint(4)]), query)).toEqual({ status: "unavailable", reason: "prefix-missing" });
    }
  });

  it("C1: irreversible expiry/horizon/revocation cannot turn a prior nonzero bucket into zero", () => {
    const original = state([completion(1), checkpoint(1)]);
    const short = clampProposedCountDeadline(original, 30), longAgain = clampProposedCountDeadline(short, 1000);
    expect(longAgain.countDeadline).toBe(30);
    const expired = advanceProposedAsOfClock(longAgain, 30);
    const restarted = JSON.parse(JSON.stringify(expired));
    expect(readProposedAsOf(advanceProposedAsOfClock(restarted, 1), query)).toEqual({ status: "unavailable", reason: "count-invalid" });
    const deleted = invalidateProposedCountsBefore(original, 11);
    expect(readProposedAsOf(invalidateProposedCountsBefore(deleted, 0), query)).toEqual({ status: "unavailable", reason: "count-invalid" });
    expect(readProposedAsOf(revokeProposedAsOf(original), query)).toEqual({ status: "unavailable", reason: "count-invalid" });
    expect(readProposedAsOf(createProposedAsOf(scope, 100, 11), query)).toEqual({ status: "unavailable", reason: "count-invalid" });
  });

  it("C2: delayed checkpoints below received presence are ordinary reordering, while unknown old IDs stay unknown", () => {
    const s = state([completion(2), completion(1), checkpoint(2, 2), checkpoint(1)]);
    expect(readProposedAsOf(s, query)).toMatchObject({ status: "scoped-as-of-model", evaluated: 1, throughSequence: 1 });
    expect(readProposedAsOf(state([completion(1), checkpoint(1, 2)]), query)).toEqual({ status: "unavailable", reason: "checkpoint-unknown" });
  });

  it("C3/C4: pending equal-clock commits and late prepared work change a later cut without contradicting the old qualified cohort", () => {
    const ledger = completionLedger([
      { completionId: "completion-1", scope, sequence: 1, occurredAt: 10, committedAt: 20, commitOrder: 1, candidate: false },
      { completionId: "completion-2", scope, sequence: 2, occurredAt: 10, committedAt: 20, commitOrder: 2, candidate: true },
    ]);
    // Wall-clock 20 contains both commits. A logical cut after commit 1 explicitly does not.
    expect(oracleCounts(ledger, scope, 10, 11, 20)).toEqual({ evaluated: 2, candidate: 1 });
    const prefix = state([completion(1), checkpoint(1)]), suffix = state([completion(1), checkpoint(1), completion(2, 10, true), checkpoint(2, 2)]);
    const old = readProposedAsOf(prefix, query);
    expect(readProposedAsOf(suffix, query)).toEqual(old);
    expect(old).toMatchObject({ evaluated: 1, candidate: 0, final: false });
    expect(readProposedAsOf(suffix, { ...query, checkpointId: 2 })).toMatchObject({ evaluated: 2, candidate: 1, final: false });
    // There is no exported wall-time frontier, final bucket or heartbeat-to-zero inference.
  });

  it("retains identity, sequence, checkpoint and monotonic-history contradictions", () => {
    const first = completion(1); if (first.kind !== "completion") throw new Error();
    const cases = [
      [first, { ...first, candidate: true }, checkpoint(1)],
      [first, { ...first, sequence: 2, digest: digest(2) }, checkpoint(2)],
      [first, { ...first, sequence: 2, completionId: "other" }, checkpoint(2)],
      [first, checkpoint(1), { ...checkpoint(1), digest: digest(9999) }],
      [first, checkpoint(1), checkpoint(0, 2)],
      [first, { ...checkpoint(1), digest: first.digest }],
      [first, checkpoint(1), { ...checkpoint(1, 2), digest: digest(1001) }],
    ];
    for (const facts of cases) expect(readProposedAsOf(state(facts), query)).toEqual({ status: "unavailable", reason: "conflict" });
  });

  it("never combines scope, epoch or membership revisions and cannot extend count validity", () => {
    const s = state([checkpoint(0)]);
    for (const field of ["tenant", "streamId", "epoch", "membershipRevision"] as const) expect(readProposedAsOf(s, { ...query, scope: { ...scope, [field]: "other" } })).toEqual({ status: "unavailable", reason: "scope" });
    expect(clampProposedCountDeadline(s, 200).countDeadline).toBe(100);
    expect(readProposedAsOf(advanceProposedAsOfClock(s, 100), query)).toEqual({ status: "unavailable", reason: "count-invalid" });
  });

  it("keeps a contradictory 65th fact terminal rather than preserving a clean prefix", () => {
    const facts = [...Array.from({ length: 63 }, (_, i) => completion(i + 1)), checkpoint(63)];
    const full = state(facts); expect(applyProposedAsOfFact(full, facts[0]!)).toBe(full);
    const conflict = completion(1, 11);
    const capacity = applyProposedAsOfFact(full, conflict);
    expect(capacity.status).toBe("capacity");
    expect(readProposedAsOf(capacity, query)).toEqual({ status: "unavailable", reason: "capacity" });
    expect(applyProposedAsOfFact(capacity, checkpoint(0))).toBe(capacity);
  });

  it("agrees with independent full completion truth across every delivery subset and named cut", () => {
    const source = completionLedger(Array.from({ length: 4 }, (_, i): SyntheticCompletion => ({ completionId: `completion-${i + 1}`, scope,
      sequence: i + 1, occurredAt: i % 2 === 0 ? 10 : 9, committedAt: i + 1, commitOrder: i + 1, candidate: i === 2 })));
    for (let mask = 0; mask < 16; mask++) for (let cut = 0; cut <= 4; cut++) {
      const facts = source.filter((_, i) => (mask & (1 << i)) !== 0).map((e) => completion(e.sequence, e.occurredAt, e.candidate));
      const result = readProposedAsOf(state([...facts, checkpoint(cut)]), query);
      const present = source.filter((e) => e.sequence <= cut).every((e) => (mask & (1 << (e.sequence - 1))) !== 0);
      if (present) expect(result).toMatchObject({ status: "scoped-as-of-model", ...oracleCounts(source, scope, 10, 11, cut), final: false, runtimeApproved: false });
      else expect(result.status).toBe("unavailable");
    }
  });

  it("converges across reordered checkpoints, presence and retry without contaminating an older cut", () => {
    function* permutations<T>(items: readonly T[]): Generator<readonly T[]> {
      if (items.length === 0) { yield []; return; }
      for (let i = 0; i < items.length; i++) {
        for (const rest of permutations(items.filter((_, j) => i !== j))) yield [items[i]!, ...rest];
      }
    }
    const facts = [completion(1), completion(2, 10, true), checkpoint(1), checkpoint(2, 2), completion(1)];
    const expected = state(facts);
    for (const order of permutations(facts)) {
      const actual = state(order);
      expect(actual).toEqual(expected);
      expect(readProposedAsOf(actual, query)).toMatchObject({ evaluated: 1, candidate: 0 });
      expect(readProposedAsOf(actual, { ...query, checkpointId: 2 })).toMatchObject({ evaluated: 2, candidate: 1 });
    }
  });
});
