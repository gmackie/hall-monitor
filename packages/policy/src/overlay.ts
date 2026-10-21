import { Audience, Decision, MachineCode, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import { AnswerAssistance, ClassifierFailureMode, ModerationMode, type PolicyProfile } from "./profile.ts";
import {
  ANSWER_ASSISTANCE_STRICTNESS,
  decisionRank,
  FAILURE_MODE_STRICTNESS,
  MODERATION_STRICTNESS,
} from "./strictness.ts";

/**
 * Changes a narrower scope (school, course, teacher) asks to make to a floor. Omitted fields keep
 * the floor's value; the result is published under the overlay's own revision.
 */
export const PolicyOverlay = z.object({
  id: OpaqueId.optional(),
  revision: OpaqueId,
  audience: Audience.optional(),
  studentFacing: z.boolean().optional(),
  inputModeration: ModerationMode.optional(),
  outputModeration: ModerationMode.optional(),
  answerAssistance: AnswerAssistance.optional(),
  escalation: z
    .object({ enabled: z.boolean().optional(), maxShare: z.number().min(0).max(1).optional() })
    .optional(),
  failureMode: z.object({ classifierUnavailable: ClassifierFailureMode.optional() }).optional(),
  actionOverrides: z.record(MachineCode, Decision).optional(),
});
/** Changes a narrower scope asks to make to a floor. */
export type PolicyOverlay = z.infer<typeof PolicyOverlay>;

/** A requested change that would have weakened the floor, and was clamped to the floor's value. */
export interface OverlayViolation {
  /** Dotted path of the profile field, e.g. `escalation.enabled`. */
  readonly field: string;
  readonly floor: string;
  readonly requested: string;
}

/** The effective profile after an overlay, plus every weakening that was refused. */
export interface OverlayResult {
  readonly profile: PolicyProfile;
  readonly violations: readonly OverlayViolation[];
}

/**
 * Applies a narrower scope's overlay to a floor. Overlays may only tighten: a weakening change is
 * clamped to the floor's value and reported, so callers can either reject the overlay outright
 * (any violations) or accept the clamped profile.
 *
 * Tightening means: moderation `off` → `optional` → `required`; answer assistance `direct` →
 * `contextual` → `scaffolded`; escalation and student-facing can be switched on but not off;
 * the escalation share target can rise but not fall; `deterministic_only` → `fail_closed`; and an
 * action override can only raise the minimum decision for its reason code. The audience is fixed.
 */
export function applyOverlay(floor: PolicyProfile, overlay: PolicyOverlay): OverlayResult {
  const requested = PolicyOverlay.parse(overlay);
  const violations: OverlayViolation[] = [];

  function tighten<T extends string | number | boolean>(field: string, floorValue: T, value: T | undefined, atLeast: (a: T, b: T) => boolean): T {
    if (value === undefined) return floorValue;
    if (atLeast(value, floorValue)) return value;
    violations.push({ field, floor: String(floorValue), requested: String(value) });
    return floorValue;
  }
  const byOrder =
    <T>(order: readonly T[]) =>
    (a: T, b: T) =>
      order.indexOf(a) >= order.indexOf(b);
  const trueWins = (a: boolean, b: boolean) => a || !b;

  const profile: PolicyProfile = {
    id: requested.id ?? floor.id,
    revision: requested.revision,
    audience: tighten("audience", floor.audience, requested.audience, (a, b) => a === b),
    studentFacing: tighten("studentFacing", floor.studentFacing, requested.studentFacing, trueWins),
    inputModeration: tighten("inputModeration", floor.inputModeration, requested.inputModeration, byOrder(MODERATION_STRICTNESS)),
    outputModeration: tighten("outputModeration", floor.outputModeration, requested.outputModeration, byOrder(MODERATION_STRICTNESS)),
    answerAssistance: tighten(
      "answerAssistance",
      floor.answerAssistance,
      requested.answerAssistance,
      byOrder(ANSWER_ASSISTANCE_STRICTNESS),
    ),
    escalation: {
      enabled: tighten("escalation.enabled", floor.escalation.enabled, requested.escalation?.enabled, trueWins),
      maxShare: tighten("escalation.maxShare", floor.escalation.maxShare, requested.escalation?.maxShare, (a, b) => a >= b),
    },
    failureMode: {
      classifierUnavailable: tighten(
        "failureMode.classifierUnavailable",
        floor.failureMode.classifierUnavailable,
        requested.failureMode?.classifierUnavailable,
        byOrder(FAILURE_MODE_STRICTNESS),
      ),
      budgetExhausted: floor.failureMode.budgetExhausted,
    },
  };

  const overrides: Record<string, Decision> = { ...floor.actionOverrides };
  for (const [reasonCode, decision] of Object.entries(requested.actionOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const floorDecision = floor.actionOverrides?.[reasonCode];
    overrides[reasonCode] = tighten(`actionOverrides.${reasonCode}`, floorDecision ?? decision, decision, (a, b) => decisionRank(a) >= decisionRank(b));
  }
  if (Object.keys(overrides).length > 0) profile.actionOverrides = overrides;

  return { profile, violations };
}
