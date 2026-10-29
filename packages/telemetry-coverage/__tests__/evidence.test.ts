import { describe, expect, it } from "vitest";
import {
  applyEvidence, emptyEvidence, summarizeEvidence,
  type ExperimentalEvidenceFact, type ExperimentalEvidenceState,
} from "../src/index.ts";
import { checkpoint, delivery, digest, SCOPE } from "./fixtures.ts";

const apply = (facts: readonly ExperimentalEvidenceFact[]) => facts.reduce(applyEvidence, emptyEvidence());
function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length === 0) { yield []; return; }
  for (let n = 0; n < items.length; n++) {
    for (const rest of permutations([...items.slice(0, n), ...items.slice(n + 1)])) yield [items[n]!, ...rest];
  }
}

describe("finite scoped evidence", () => {
  it("converges over all 720 benign permutations without tainting checkpoints behind presence", () => {
    const facts = [delivery(1), delivery(2), delivery(3), delivery(1), checkpoint(1, 1), checkpoint(2, 2)];
    const expected = summarizeEvidence(apply(facts), SCOPE);
    let orders = 0;
    for (const order of permutations(facts)) {
      let state = emptyEvidence();
      for (const fact of order) {
        state = applyEvidence(state, fact);
        expect(summarizeEvidence(state, SCOPE)).toMatchObject({ kind: "observed", conflicts: [] });
      }
      expect(summarizeEvidence(state, SCOPE)).toEqual(expected);
      orders++;
    }
    expect(orders).toBe(720);
    expect(expected).toMatchObject({ contiguousSequence: 3, deliveredSequences: [1, 2, 3] });
  });

  it("keeps gaps in presence separate from checkpoint assertions", () => {
    expect(summarizeEvidence(apply([delivery(3), checkpoint(1, 8)]), SCOPE)).toMatchObject({
      contiguousSequence: 0, deliveredSequences: [3], conflicts: [],
    });
    expect(summarizeEvidence(apply([delivery(3), delivery(1)]), SCOPE)).toMatchObject({ contiguousSequence: 1 });
  });

  it.each([
    [delivery(1), delivery(1, { digest: digest(20) }), "delivery_identity"],
    [delivery(1), delivery(2, { deliveryId: "delivery-1" }), "delivery_identity"],
    [delivery(1), delivery(1, { deliveryId: "another" }), "delivery_sequence"],
    [checkpoint(1, 1), checkpoint(1, 1, { digest: digest(20) }), "checkpoint_identity"],
    [checkpoint(1, 1), checkpoint(1, 2), "checkpoint_identity"],
  ] as const)("preserves contradictory identities independent of arrival order", (a, b, kind) => {
    const expected = summarizeEvidence(apply([a, b]), SCOPE);
    expect(expected).toEqual(summarizeEvidence(apply([b, a, a, b]), SCOPE));
    expect(expected).toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ kind })]) });
  });

  it.each(["tenant", "streamId", "epoch"] as const)("isolates reused local labels by %s", (key) => {
    const scope = { ...SCOPE, [key]: "another-synthetic-scope" };
    const state = apply([delivery(1), checkpoint(1, 1), delivery(1, { scope, digest: digest(20) }), checkpoint(1, 9, { scope })]);
    expect(summarizeEvidence(state, SCOPE)).toMatchObject({ conflicts: [], contiguousSequence: 1 });
    expect(summarizeEvidence(state, scope)).toMatchObject({ conflicts: [], contiguousSequence: 1 });
  });

  it("treats replay at capacity as a no-op, then terminates on a contradictory 65th variant", () => {
    const state = apply(Array.from({ length: 64 }, (_, i) => delivery(i + 1)));
    expect(applyEvidence(state, delivery(1))).toBe(state);
    const full = applyEvidence(state, delivery(1, { digest: digest(99) }));
    expect(full).toEqual({ kind: "capacity", limit: 64 });
    expect(summarizeEvidence(full, SCOPE)).toEqual({ kind: "capacity", limit: 64 });
    expect(applyEvidence(full, checkpoint(1, 1))).toBe(full);
  });

  it("applies the capacity bound across scopes and never mutates an earlier state", () => {
    const empty = emptyEvidence();
    let state = empty;
    for (let i = 0; i < 65; i++) state = applyEvidence(state, delivery(1, { scope: { ...SCOPE, tenant: `synthetic-${i}` } }));
    expect(state.kind).toBe("capacity");
    expect(empty).toEqual({ kind: "open", facts: [] });
  });

  it("survives serialization without changing identities or conflicts", () => {
    const state = apply([delivery(1), delivery(1, { digest: digest(20) }), checkpoint(5, 1)]);
    const restored = JSON.parse(JSON.stringify(state)) as ExperimentalEvidenceState;
    expect(summarizeEvidence(restored, SCOPE)).toEqual(summarizeEvidence(state, SCOPE));
    expect(applyEvidence(restored, delivery(1))).toBe(restored);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid synthetic sequence %s", (sequence) => {
    expect(() => applyEvidence(emptyEvidence(), delivery(sequence))).toThrow(TypeError);
  });

  it("copies input facts so external mutation cannot erase evidence", () => {
    const scope = { ...SCOPE };
    const fact = { ...delivery(1), scope };
    const state = applyEvidence(emptyEvidence(), fact);
    fact.digest = digest(99);
    scope.tenant = "changed";
    expect(summarizeEvidence(state, SCOPE)).toMatchObject({ deliveries: [delivery(1)] });
  });

  it.each([
    delivery(1, { digest: "not-a-digest" }), delivery(1, { deliveryId: "" }),
    delivery(1, { scope: { ...SCOPE, tenant: "" } }),
    checkpoint(0, 1), checkpoint(1, -1), checkpoint(1, NaN), checkpoint(1, Infinity),
  ])("rejects malformed fact identities before consuming capacity", (fact) => {
    const state = emptyEvidence();
    expect(() => applyEvidence(state, fact)).toThrow(TypeError);
    expect(state).toEqual({ kind: "open", facts: [] });
  });
});
