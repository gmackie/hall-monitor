import { PolicyProfile } from "./profile.ts";

/** The revision every built-in profile is published under. */
export const BUILTIN_PROFILE_REVISION = "builtin-1";

function define(profile: PolicyProfile): PolicyProfile {
  const parsed = PolicyProfile.parse(profile);
  Object.freeze(parsed.escalation);
  Object.freeze(parsed.failureMode);
  return Object.freeze(parsed);
}

/**
 * Educator-facing work: incoming text is moderated, outgoing optionally, answers may be direct.
 * Images are classified.
 */
export const EDUCATOR_PROFILE = define({
  id: "educator",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "educator",
  studentFacing: false,
  inputModeration: "required",
  outputModeration: "optional",
  answerAssistance: "direct",
  escalation: { enabled: true, maxShare: 0.1 },
  failureMode: { classifierUnavailable: "deterministic_only", budgetExhausted: "block_generative" },
  imageModeration: true,
});

/**
 * Students in grades 6-8: both directions moderated, scaffolded help, fail closed. Image
 * moderation is off until image thresholds are calibrated for the band, so every image is held.
 */
export const STUDENT_6_8_PROFILE = define({
  id: "student-6-8",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "student",
  studentFacing: true,
  inputModeration: "required",
  outputModeration: "required",
  answerAssistance: "scaffolded",
  escalation: { enabled: true, maxShare: 0.1 },
  failureMode: { classifierUnavailable: "fail_closed", budgetExhausted: "block_generative" },
});

/**
 * Students in grades 9-12: both directions moderated, contextual help, fail closed. Image
 * moderation is off until image thresholds are calibrated for the band, so every image is held.
 */
export const STUDENT_9_12_PROFILE = define({
  id: "student-9-12",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "student",
  studentFacing: true,
  inputModeration: "required",
  outputModeration: "required",
  answerAssistance: "contextual",
  escalation: { enabled: true, maxShare: 0.1 },
  failureMode: { classifierUnavailable: "fail_closed", budgetExhausted: "block_generative" },
});

/**
 * Content proposed for publication. Candidates are checked on the way in; there is no output
 * stage. Safety-critical publishing holds rather than publishing unreviewed. Images are
 * classified, and ambiguous ones are held.
 */
export const PUBLISHED_CONTENT_PROFILE = define({
  id: "published-content",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "public",
  studentFacing: false,
  inputModeration: "required",
  outputModeration: "off",
  answerAssistance: "contextual",
  escalation: { enabled: true, maxShare: 0.1 },
  failureMode: { classifierUnavailable: "fail_closed", budgetExhausted: "block_generative" },
  imageModeration: true,
});

/**
 * Lines a product speaks aloud to learners (text-to-speech), evaluated in their spoken form:
 * composed episode lines and hint, praise and retry feedback. Both directions are moderated and
 * fail closed, with Clef enforcing and escalating as for other student-facing content. The
 * voice-line evaluators (speakability, spoken answer leakage, kid tone) select themselves by
 * surface; see {@link VOICE_LINE_SURFACES}.
 */
export const VOICE_LINES_PROFILE = define({
  id: "voice-lines",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "student",
  studentFacing: true,
  inputModeration: "required",
  outputModeration: "required",
  answerAssistance: "scaffolded",
  escalation: { enabled: true, maxShare: 0.1 },
  failureMode: { classifierUnavailable: "fail_closed", budgetExhausted: "block_generative" },
});

/**
 * The sentence-level gate just before text-to-speech, which must answer without a model call:
 * model families are off and nothing escalates, so only the deterministic bundle decides and no
 * receipt is produced. Moderation is `optional` rather than `required` because a required stage
 * with no model family resolves as an unavailable classifier; the line's content is expected to
 * have been moderated upstream (as `voice_line.composed` or `voice_line.feedback`).
 */
export const VOICE_LINES_LIVE_PROFILE = define({
  id: "voice-lines-live",
  revision: BUILTIN_PROFILE_REVISION,
  audience: "student",
  studentFacing: true,
  inputModeration: "optional",
  outputModeration: "optional",
  answerAssistance: "scaffolded",
  escalation: { enabled: false, maxShare: 0 },
  failureMode: { classifierUnavailable: "deterministic_only", budgetExhausted: "block_generative" },
  routing: { clef: { enabled: false, mode: "shadow" }, clairic: { enabled: false, mode: "shadow" } },
});

/** Every built-in profile, keyed by id. */
export const BUILTIN_PROFILES: Readonly<Record<string, PolicyProfile>> = Object.freeze({
  [EDUCATOR_PROFILE.id]: EDUCATOR_PROFILE,
  [STUDENT_6_8_PROFILE.id]: STUDENT_6_8_PROFILE,
  [STUDENT_9_12_PROFILE.id]: STUDENT_9_12_PROFILE,
  [PUBLISHED_CONTENT_PROFILE.id]: PUBLISHED_CONTENT_PROFILE,
  [VOICE_LINES_PROFILE.id]: VOICE_LINES_PROFILE,
  [VOICE_LINES_LIVE_PROFILE.id]: VOICE_LINES_LIVE_PROFILE,
});

/**
 * Surfaces whose text is a spoken line: `composed` (episode lines, checked when the episode is
 * built), `feedback` (hint, praise and retry lines) and `live` (one sentence, checked just before
 * text-to-speech). The voice-line evaluators run only on these surfaces.
 */
export const VOICE_LINE_SURFACES = Object.freeze(["voice_line.composed", "voice_line.feedback", "voice_line.live"] as const);
/** A spoken-line surface. */
export type VoiceLineSurface = (typeof VOICE_LINE_SURFACES)[number];

/** Whether `surface` carries spoken lines. */
export function isVoiceLineSurface(surface: string): surface is VoiceLineSurface {
  return (VOICE_LINE_SURFACES as readonly string[]).includes(surface);
}

/**
 * The built-in profile each voice-line surface is evaluated under. Profiles are chosen by the
 * caller (`policy.profileId`), not by the service, so this is the documented pairing: the live
 * gate must take `voice-lines-live` to stay model-free.
 */
export const VOICE_LINE_SURFACE_PROFILES: Readonly<Record<VoiceLineSurface, PolicyProfile>> = Object.freeze({
  "voice_line.composed": VOICE_LINES_PROFILE,
  "voice_line.feedback": VOICE_LINES_PROFILE,
  "voice_line.live": VOICE_LINES_LIVE_PROFILE,
});

/** The built-in profile for a voice-line surface; undefined for any other surface. */
export function voiceLineProfileFor(surface: string): PolicyProfile | undefined {
  return isVoiceLineSurface(surface) ? VOICE_LINE_SURFACE_PROFILES[surface] : undefined;
}
