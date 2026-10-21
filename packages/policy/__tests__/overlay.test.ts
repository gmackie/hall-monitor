import { describe, expect, it } from "vitest";
import {
  AnswerAssistance,
  applyOverlay,
  BUILTIN_PROFILES,
  ClassifierFailureMode,
  decisionRank,
  EDUCATOR_PROFILE,
  ModerationMode,
  PUBLISHED_CONTENT_PROFILE,
  PolicyProfile,
  resolveDecision,
  STUDENT_6_8_PROFILE,
  STUDENT_9_12_PROFILE,
} from "../src/index.ts";
import { pick, randomFinding, seededRandom } from "./random.ts";

describe("built-in profiles", () => {
  it("are valid and frozen", () => {
    for (const profile of Object.values(BUILTIN_PROFILES)) {
      expect(PolicyProfile.parse(profile)).toEqual(profile);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.failureMode)).toBe(true);
    }
  });

  it("fail closed for students", () => {
    expect(STUDENT_6_8_PROFILE.failureMode.classifierUnavailable).toBe("fail_closed");
    expect(STUDENT_9_12_PROFILE.outputModeration).toBe("required");
  });
});

describe("applyOverlay", () => {
  it("accepts tightening changes", () => {
    const { profile, violations } = applyOverlay(STUDENT_9_12_PROFILE, {
      id: "course-bio-201",
      revision: "course:4",
      answerAssistance: "scaffolded",
      actionOverrides: { "privacy.email": "hold" },
    });
    expect(violations).toEqual([]);
    expect(profile).toMatchObject({ id: "course-bio-201", revision: "course:4", answerAssistance: "scaffolded" });
    expect(profile.actionOverrides).toEqual({ "privacy.email": "hold" });
  });

  it("clamps and reports every weakening of a district floor", () => {
    const floor = { ...STUDENT_9_12_PROFILE, actionOverrides: { "privacy.phone": "hold" as const } };
    const { profile, violations } = applyOverlay(floor, {
      revision: "teacher:9",
      audience: "educator",
      studentFacing: false,
      inputModeration: "off",
      outputModeration: "optional",
      answerAssistance: "direct",
      escalation: { enabled: false, maxShare: 0.01 },
      failureMode: { classifierUnavailable: "deterministic_only" },
      actionOverrides: { "privacy.phone": "allow" },
    });
    expect(violations.map((violation) => violation.field)).toEqual([
      "audience",
      "studentFacing",
      "inputModeration",
      "outputModeration",
      "answerAssistance",
      "escalation.enabled",
      "escalation.maxShare",
      "failureMode.classifierUnavailable",
      "actionOverrides.privacy.phone",
    ]);
    expect(violations[2]).toEqual({ field: "inputModeration", floor: "required", requested: "off" });
    expect({ ...profile, revision: floor.revision }).toEqual(floor);
  });

  it("never yields a profile that decides more leniently than its floor (seeded property test)", () => {
    const random = seededRandom(7);
    const floors = Object.values(BUILTIN_PROFILES);
    for (let i = 0; i < 1000; i++) {
      const floor = pick(random, floors);
      const maybe = <T>(value: T) => (random() < 0.5 ? value : undefined);
      const overlay = {
        revision: `overlay-${i}`,
        ...defined({
          inputModeration: maybe(pick(random, ModerationMode.options)),
          outputModeration: maybe(pick(random, ModerationMode.options)),
          answerAssistance: maybe(pick(random, AnswerAssistance.options)),
          studentFacing: maybe(random() < 0.5),
        }),
        escalation: defined({ enabled: maybe(random() < 0.5), maxShare: maybe(random()) }),
        failureMode: defined({ classifierUnavailable: maybe(pick(random, ClassifierFailureMode.options)) }),
      };
      const { profile } = applyOverlay(floor, overlay);
      expect(PolicyProfile.parse(profile)).toEqual(profile);

      const findings = Array.from({ length: 3 }, () => randomFinding(random));
      const context = { audience: floor.audience, graded: random() < 0.5 };
      const flags = { classifierUnavailable: random() < 0.3, uncertain: random() < 0.3 };
      const before = resolveDecision(floor, findings, context, flags).decision;
      const after = resolveDecision(profile, findings, context, flags).decision;
      expect(decisionRank(after)).toBeGreaterThanOrEqual(decisionRank(before));
    }
  });

  it("rejects malformed overlays", () => {
    expect(() => applyOverlay(EDUCATOR_PROFILE, { revision: "x", inputModeration: "sometimes" as never })).toThrow();
  });
});

function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

describe("image moderation", () => {
  it("is on for educator and published content, and off for student floors until calibrated", () => {
    expect(EDUCATOR_PROFILE.imageModeration).toBe(true);
    expect(PUBLISHED_CONTENT_PROFILE.imageModeration).toBe(true);
    expect(STUDENT_6_8_PROFILE.imageModeration).toBeUndefined();
    expect(STUDENT_9_12_PROFILE.imageModeration).toBeUndefined();
  });

  it("cannot be enabled by an overlay on a fail-closed floor, where off holds every image", () => {
    const { profile, violations } = applyOverlay(STUDENT_9_12_PROFILE, { revision: "district:1", imageModeration: true });
    expect(profile.imageModeration).toBe(false);
    expect(violations).toEqual([{ field: "imageModeration", floor: "false", requested: "true" }]);
    expect(applyOverlay(PUBLISHED_CONTENT_PROFILE, { revision: "district:1", imageModeration: false })).toMatchObject({
      profile: { imageModeration: false },
      violations: [],
    });
  });

  it("cannot be disabled on a deterministic-only floor, where off lets images through unmoderated", () => {
    const { profile, violations } = applyOverlay(EDUCATOR_PROFILE, { revision: "district:1", imageModeration: false });
    expect(profile.imageModeration).toBe(true);
    expect(violations).toEqual([{ field: "imageModeration", floor: "true", requested: "false" }]);
    // Tightening the failure mode to fail_closed in the same overlay makes off the strict choice.
    const strict = applyOverlay(EDUCATOR_PROFILE, { revision: "district:2", imageModeration: false, failureMode: { classifierUnavailable: "fail_closed" } });
    expect(strict.violations).toEqual([]);
    expect(strict.profile).toMatchObject({ imageModeration: false, failureMode: { classifierUnavailable: "fail_closed" } });
  });

  it("leaves profiles without the field unchanged when an overlay does not mention it", () => {
    expect(applyOverlay(STUDENT_9_12_PROFILE, { revision: "district:1" }).profile).not.toHaveProperty("imageModeration");
    expect(applyOverlay(EDUCATOR_PROFILE, { revision: "district:1" }).profile.imageModeration).toBe(true);
  });
});
