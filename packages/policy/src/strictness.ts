import type { Decision } from "@gmacko/hall-monitor-contracts";
import type { AnswerAssistance, ClassifierFailureMode, ModerationMode } from "./profile.ts";

/**
 * Decisions from most to least precedent. `support` outranks everything so a distressed learner
 * always reaches the supportive path; it is a different route, not a harsher rejection.
 */
export const DECISION_PRECEDENCE: readonly Decision[] = Object.freeze(["support", "block", "hold", "coach", "allow"]);

/** A decision's precedence; higher wins. */
export function decisionRank(decision: Decision): number {
  return DECISION_PRECEDENCE.length - 1 - DECISION_PRECEDENCE.indexOf(decision);
}

/** The decision with the higher precedence. */
export function strongerDecision(left: Decision, right: Decision): Decision {
  return decisionRank(right) > decisionRank(left) ? right : left;
}

/** Moderation modes from least to most strict. */
export const MODERATION_STRICTNESS: readonly ModerationMode[] = Object.freeze(["off", "optional", "required"]);

/** Answer assistance from least to most strict. */
export const ANSWER_ASSISTANCE_STRICTNESS: readonly AnswerAssistance[] = Object.freeze(["direct", "contextual", "scaffolded"]);

/** Classifier failure modes from least to most strict. */
export const FAILURE_MODE_STRICTNESS: readonly ClassifierFailureMode[] = Object.freeze(["deterministic_only", "fail_closed"]);
