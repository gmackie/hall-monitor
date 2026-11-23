import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILE_REVISION,
  BUILTIN_PROFILES,
  isVoiceLineSurface,
  routeFor,
  VOICE_LINE_SURFACES,
  VOICE_LINES_LIVE_PROFILE,
  VOICE_LINES_PROFILE,
  voiceLineProfileFor,
} from "../src/index.ts";

describe("voice-line profiles", () => {
  it("pairs each voice-line surface with its built-in profile", () => {
    expect(VOICE_LINE_SURFACES).toEqual(["voice_line.composed", "voice_line.feedback", "voice_line.live"]);
    expect(voiceLineProfileFor("voice_line.composed")?.id).toBe("voice-lines");
    expect(voiceLineProfileFor("voice_line.feedback")?.id).toBe("voice-lines");
    expect(voiceLineProfileFor("voice_line.live")?.id).toBe("voice-lines-live");
    expect(voiceLineProfileFor("student.chat")).toBeUndefined();
    expect(isVoiceLineSurface("voice_line.other")).toBe(false);
  });

  it("registers both as built-in floors under the built-in revision", () => {
    expect(BUILTIN_PROFILES["voice-lines"]).toBe(VOICE_LINES_PROFILE);
    expect(BUILTIN_PROFILES["voice-lines-live"]).toBe(VOICE_LINES_LIVE_PROFILE);
    for (const profile of [VOICE_LINES_PROFILE, VOICE_LINES_LIVE_PROFILE]) {
      expect(profile).toMatchObject({ revision: BUILTIN_PROFILE_REVISION, audience: "student", studentFacing: true, answerAssistance: "scaffolded" });
    }
  });

  it("moderates composed and feedback lines like student content: Clef enforces and escalates, fail closed", () => {
    expect(VOICE_LINES_PROFILE).toMatchObject({ inputModeration: "required", escalation: { enabled: true } });
    expect(VOICE_LINES_PROFILE.failureMode.classifierUnavailable).toBe("fail_closed");
    expect(routeFor(VOICE_LINES_PROFILE, "clef", "content.candidate")).toEqual({ enabled: true, mode: "enforce" });
    expect(routeFor(VOICE_LINES_PROFILE, "clairic", "content.candidate")).toBeNull();
  });

  it("keeps the live gate model-free: no family routed, no escalation, no failing closed on a missing model", () => {
    for (const kind of ["content.candidate", "interaction.output"] as const) {
      expect(routeFor(VOICE_LINES_LIVE_PROFILE, "clef", kind)).toBeNull();
      expect(routeFor(VOICE_LINES_LIVE_PROFILE, "clairic", kind)).toBeNull();
    }
    expect(VOICE_LINES_LIVE_PROFILE.escalation.enabled).toBe(false);
    expect(VOICE_LINES_LIVE_PROFILE.inputModeration).toBe("optional");
    expect(VOICE_LINES_LIVE_PROFILE.failureMode.classifierUnavailable).toBe("deterministic_only");
  });
});
