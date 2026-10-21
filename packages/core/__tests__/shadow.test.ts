import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { defaultBundle } from "@gmacko/hall-monitor-evaluators";
import { BUILTIN_PROFILES, type PolicyProfile, resolveDecision } from "@gmacko/hall-monitor-policy";
import { CORPUS, type FixtureCase, fixtureRequest } from "@gmacko/hall-monitor-test-fixtures";
import { describe, expect, it } from "vitest";
import { type EvaluateDeps, evaluate, type EnforcementOptions, shadowResult } from "../src/index.ts";

function deps(overrides: Partial<EvaluateDeps> = {}): EvaluateDeps {
  return {
    policies: (id, revision) => (revision === "builtin-1" ? BUILTIN_PROFILES[id] : undefined),
    bundle: defaultBundle,
    priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
    clock: () => new Date("2026-10-20T12:00:00.000Z"),
    ids: { evaluationId: () => "eval_1", receiptId: () => "rcpt_1" },
    ...overrides,
  };
}

/** A corpus case moved to the educator audience, whose profile is shadowable by default. */
function educator(id: string): FixtureCase {
  const found = CORPUS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return { ...found, audience: "educator" };
}

const shadow: EnforcementOptions = { mode: "shadow" };

describe("shadow mode", () => {
  it("returns allow and records the would-be decision for a shadowable profile", async () => {
    const request = fixtureRequest(educator("harmful-01"));
    const enforced = await evaluate(request, deps());
    expect(enforced.decision).toBe("block");
    const shadowed = await evaluate(request, deps({ enforcement: shadow }));
    expect(shadowed).toEqual({
      ...enforced,
      decision: "allow",
      reasonCodes: ["hall_monitor.shadow"],
      shadow: { decision: "block", reasonCodes: enforced.reasonCodes },
    });
    expect(EvaluationResult.parse(shadowed)).toEqual(shadowed);
  });

  it("marks allowed shadow traffic too", async () => {
    const result = await evaluate(fixtureRequest(educator("benign-02")), deps({ enforcement: shadow }));
    expect(result).toMatchObject({ decision: "allow", reasonCodes: ["hall_monitor.shadow"], shadow: { decision: "allow", reasonCodes: ["hall_monitor.deterministic_only"] } });
  });

  it("never shadows support", async () => {
    const request = fixtureRequest(educator("distress-01"));
    const result = await evaluate(request, deps({ enforcement: shadow }));
    expect(result.decision).toBe("support");
    expect(result.shadow).toBeUndefined();
  });

  it("enforces student profiles with required input moderation unless the tenant allows student shadow", async () => {
    const request = fixtureRequest(CORPUS.find((candidate) => candidate.id === "harmful-01")!);
    const refused: PolicyProfile[] = [];
    const enforced = await evaluate(request, deps({ enforcement: { mode: "shadow", onShadowRefused: (profile) => refused.push(profile) } }));
    expect(enforced.decision).toBe("block");
    expect(enforced.shadow).toBeUndefined();
    expect(refused.map((profile) => profile.id)).toEqual(["student-9-12"]);

    const allowed = await evaluate(request, deps({ enforcement: { mode: "shadow", allowStudentShadow: true } }));
    expect(allowed).toMatchObject({ decision: "allow", shadow: { decision: "block" } });
  });

  it("enforces by default and in enforce mode", async () => {
    const request = fixtureRequest(educator("harmful-01"));
    expect((await evaluate(request, deps({ enforcement: { mode: "enforce" } }))).decision).toBe("block");
    expect((await evaluate(request, deps())).shadow).toBeUndefined();
  });

  it("refuses a shadow result that does not enforce allow", () => {
    const base = {
      schemaVersion: "1.0",
      evaluationId: "eval_1",
      requestId: "req_1",
      reasonCodes: [],
      findings: [],
      uncertain: false,
      policyRevision: "builtin-1",
      evaluatorBundleRevision: "base-1.0.0",
      resolverVersion: "resolver-1.0.0",
      receipt: null,
    };
    expect(EvaluationResult.safeParse({ ...base, decision: "block", shadow: { decision: "block", reasonCodes: [] } }).success).toBe(false);
    const result = EvaluationResult.parse({ ...base, decision: "hold" });
    expect(shadowResult(shadowResult(result))).toEqual(shadowResult(result));
  });
});

describe("resolver injection", () => {
  it("resolves with the injected table, for replays and diffs", async () => {
    const request = fixtureRequest(CORPUS.find((candidate) => candidate.id === "integrity-01")!);
    const result = await evaluate(request, deps({ resolve: (...args) => ({ ...resolveDecision(...args), decision: "hold", resolverVersion: "resolver-test" }) }));
    expect(result).toMatchObject({ decision: "hold", resolverVersion: "resolver-test" });
  });
});
