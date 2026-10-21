import { Decision, type Finding } from "@gmacko/hall-monitor-contracts";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  decisionRank,
  EDUCATOR_PROFILE,
  PUBLISHED_CONTENT_PROFILE,
  RESOLVER_VERSION,
  resolveDecision,
  STUDENT_6_8_PROFILE,
  STUDENT_9_12_PROFILE,
} from "../src/index.ts";
import { pick, randomFinding, seededRandom, shuffled } from "./random.ts";

const student = { audience: "student" } as const;

function finding(overrides: Partial<Finding>): Finding {
  return { evaluatorId: "test", evaluatorVersion: "1.0.0", category: "safety", reasonCode: "safety.test", severity: "info", ...overrides };
}

const distress = finding({ category: "self-harm", reasonCode: "self_harm.disclosure", severity: "support" });
const weapon = finding({ category: "safety", reasonCode: "safety.weapon_instructions", severity: "block" });
const directAnswer = finding({ category: "academic-integrity", reasonCode: "academic_integrity.direct_answer_request", severity: "warn" });

describe("resolveDecision precedence", () => {
  it("allows when there are no findings", () => {
    expect(resolveDecision(STUDENT_9_12_PROFILE, [], student)).toEqual({
      decision: "allow",
      reasonCodes: [],
      uncertain: false,
      resolverVersion: RESOLVER_VERSION,
    });
  });

  it("routes distress to support even alongside a block, still reporting the block reason", () => {
    const resolution = resolveDecision(STUDENT_6_8_PROFILE, [weapon, distress], student);
    expect(resolution.decision).toBe("support");
    expect(resolution.reasonCodes).toEqual(["self_harm.disclosure", "safety.weapon_instructions"]);
  });

  it("orders block > hold > coach > allow", () => {
    const hold = finding({ category: "rights", reasonCode: "rights.unverified", severity: "hold" });
    const warn = finding({ category: "privacy", reasonCode: "privacy.email", severity: "warn" });
    const info = finding({ category: "quality", reasonCode: "quality.note", severity: "info" });
    expect(resolveDecision(EDUCATOR_PROFILE, [info, warn, hold, weapon], student).decision).toBe("block");
    expect(resolveDecision(EDUCATOR_PROFILE, [info, warn, hold], student).decision).toBe("hold");
    expect(resolveDecision(EDUCATOR_PROFILE, [info, warn], student).decision).toBe("coach");
    expect(resolveDecision(EDUCATOR_PROFILE, [info], student).decision).toBe("allow");
  });

  it("coaches direct-answer requests by answer assistance and grading", () => {
    const decide = (profile = STUDENT_9_12_PROFILE, graded?: boolean) =>
      resolveDecision(profile, [directAnswer], graded === undefined ? student : { ...student, graded }).decision;
    expect(decide(STUDENT_9_12_PROFILE, true)).toBe("coach");
    expect(decide(STUDENT_9_12_PROFILE, false)).toBe("allow");
    expect(decide(STUDENT_6_8_PROFILE, false)).toBe("coach");
    expect(decide(STUDENT_6_8_PROFILE)).toBe("coach");
    expect(decide(EDUCATOR_PROFILE, true)).toBe("allow");
  });

  it("raises outcomes with action overrides but never lowers them", () => {
    const strict = { ...STUDENT_9_12_PROFILE, actionOverrides: { "privacy.email": "hold" as const, "safety.weapon_instructions": "allow" as const } };
    const email = finding({ category: "privacy", reasonCode: "privacy.email", severity: "warn" });
    expect(resolveDecision(strict, [email], student).decision).toBe("hold");
    expect(resolveDecision(strict, [weapon], student).decision).toBe("block");
  });
});

describe("resolveDecision failure modes", () => {
  it("holds a student request when the classifier is unavailable under fail_closed", () => {
    const resolution = resolveDecision(STUDENT_9_12_PROFILE, [], student, { classifierUnavailable: true });
    expect(resolution).toMatchObject({
      decision: "hold",
      reasonCodes: ["hall_monitor.unavailable"],
      uncertain: true,
      degraded: "classifier_unavailable",
    });
  });

  it("still offers support when the classifier is down", () => {
    expect(resolveDecision(STUDENT_9_12_PROFILE, [distress], student, { classifierTimedOut: true })).toMatchObject({
      decision: "support",
      degraded: "classifier_timeout",
    });
  });

  it("decides from deterministic findings only under deterministic_only, reported as degraded", () => {
    const resolution = resolveDecision(EDUCATOR_PROFILE, [], { audience: "educator" }, { classifierUnavailable: true });
    expect(resolution).toMatchObject({
      decision: "allow",
      reasonCodes: ["hall_monitor.deterministic_only"],
      degraded: "classifier_unavailable",
    });
    expect(resolveDecision(EDUCATOR_PROFILE, [weapon], { audience: "educator" }, { classifierUnavailable: true }).decision).toBe("block");
  });

  it("holds uncertain results under fail_closed and only flags them otherwise", () => {
    expect(resolveDecision(PUBLISHED_CONTENT_PROFILE, [], { audience: "public" }, { uncertain: true }).decision).toBe("hold");
    expect(resolveDecision(EDUCATOR_PROFILE, [], { audience: "educator" }, { uncertain: true })).toMatchObject({
      decision: "allow",
      uncertain: true,
    });
  });

  it("blocks generative work when the budget is exhausted, but keeps support open", () => {
    expect(resolveDecision(STUDENT_9_12_PROFILE, [], student, { budgetExhausted: true })).toMatchObject({
      decision: "block",
      reasonCodes: ["hall_monitor.budget_exhausted"],
      degraded: "budget_exhausted",
    });
    expect(resolveDecision(STUDENT_9_12_PROFILE, [distress], student, { budgetExhausted: true }).decision).toBe("support");
  });
});

describe("resolveDecision validation", () => {
  it("rejects unknown severities and categories instead of inventing an action", () => {
    expect(() => resolveDecision(STUDENT_9_12_PROFILE, [{ ...weapon, severity: "escalate" }], student)).toThrow();
    expect(() => resolveDecision(STUDENT_9_12_PROFILE, [{ ...weapon, category: "spam" }], student)).toThrow();
    expect(() => resolveDecision(STUDENT_9_12_PROFILE, [{ ...weapon, reasonCode: "Free text" }], student)).toThrow();
  });
});

describe("resolveDecision determinism (seeded property test)", () => {
  const random = seededRandom(20261020);
  const profiles = Object.values(BUILTIN_PROFILES);

  it("gives the same resolution for the same inputs in any order, over 2,000 generated cases", () => {
    for (let i = 0; i < 2000; i++) {
      const profile = pick(random, profiles);
      const findings = Array.from({ length: Math.floor(random() * 6) }, () => randomFinding(random));
      const context = { audience: pick(random, ["student", "educator", "public"] as const), graded: random() < 0.5 };
      const flags = { uncertain: random() < 0.2, classifierUnavailable: random() < 0.1, budgetExhausted: random() < 0.05 };

      const first = resolveDecision(profile, findings, context, flags);
      expect(resolveDecision(profile, shuffled(random, findings), context, flags)).toEqual(first);
      expect(Decision.options).toContain(first.decision);

      // Adding evidence never makes the decision more lenient.
      const more = resolveDecision(profile, [...findings, randomFinding(random)], context, flags);
      expect(decisionRank(more.decision)).toBeGreaterThanOrEqual(decisionRank(first.decision));
    }
  });
});
