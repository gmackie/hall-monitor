import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  EDUCATOR_PROFILE,
  isShadowable,
  PUBLISHED_CONTENT_PROFILE,
  shadowEligibility,
  STUDENT_9_12_PROFILE,
  VOICE_LINES_LIVE_PROFILE,
} from "../src/index.ts";

describe("shadowEligibility", () => {
  it("refuses student-facing profiles with required input moderation by default", () => {
    const required = Object.values(BUILTIN_PROFILES).filter((candidate) => candidate.studentFacing && candidate.inputModeration === "required");
    expect(required.map((profile) => profile.id).sort()).toEqual(["student-6-8", "student-9-12", "voice-lines"]);
    for (const profile of required) {
      expect(shadowEligibility(profile), profile.id).toEqual({ shadowable: false, reason: "student_required_moderation" });
      expect(isShadowable(profile, { allowStudentShadow: true }), profile.id).toBe(true);
    }
  });

  it("allows non-student profiles and student profiles without required input moderation", () => {
    expect(isShadowable(EDUCATOR_PROFILE)).toBe(true);
    expect(isShadowable(PUBLISHED_CONTENT_PROFILE)).toBe(true);
    expect(isShadowable({ ...STUDENT_9_12_PROFILE, inputModeration: "optional" })).toBe(true);
    expect(isShadowable(STUDENT_9_12_PROFILE, { allowStudentShadow: false })).toBe(false);
    // The model-free live gate moderates optionally (its content is moderated upstream), so a shadow tenant shadows it.
    expect(isShadowable(VOICE_LINES_LIVE_PROFILE)).toBe(true);
  });
});
