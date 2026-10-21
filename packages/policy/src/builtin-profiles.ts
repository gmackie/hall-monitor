import { PolicyProfile } from "./profile.ts";

/** The revision every built-in profile is published under. */
export const BUILTIN_PROFILE_REVISION = "builtin-1";

function define(profile: PolicyProfile): PolicyProfile {
  const parsed = PolicyProfile.parse(profile);
  Object.freeze(parsed.escalation);
  Object.freeze(parsed.failureMode);
  return Object.freeze(parsed);
}

/** Educator-facing work: incoming text is moderated, outgoing optionally, answers may be direct. */
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
});

/** Students in grades 6-8: both directions moderated, scaffolded help, fail closed. */
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

/** Students in grades 9-12: both directions moderated, contextual help, fail closed. */
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
 * stage. Safety-critical publishing holds rather than publishing unreviewed.
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
});

/** Every built-in profile, keyed by id. */
export const BUILTIN_PROFILES: Readonly<Record<string, PolicyProfile>> = Object.freeze({
  [EDUCATOR_PROFILE.id]: EDUCATOR_PROFILE,
  [STUDENT_6_8_PROFILE.id]: STUDENT_6_8_PROFILE,
  [STUDENT_9_12_PROFILE.id]: STUDENT_9_12_PROFILE,
  [PUBLISHED_CONTENT_PROFILE.id]: PUBLISHED_CONTENT_PROFILE,
});
