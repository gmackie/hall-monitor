import { Audience, Decision, MachineCode, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import {
  AnswerAssistance,
  ClassifierFailureMode,
  familyRouting,
  type FamilyRouting,
  MODEL_FAMILIES,
  ModerationMode,
  type PolicyProfile,
  ProfileRouting,
} from "./profile.ts";
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
  imageModeration: z.boolean().optional(),
  actionOverrides: z.record(MachineCode, Decision).optional(),
  /** Per-family routing changes; only tightening ones apply (see {@link applyOverlay}). */
  routing: ProfileRouting.optional(),
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
 *
 * Image moderation's strict direction depends on the effective failure mode, since a profile that
 * does not classify images handles them as an unavailable classifier: under `fail_closed` turning
 * it off is the tightening (every image is held), under `deterministic_only` turning it on is.
 * So an overlay cannot enable image moderation on a fail-closed floor that leaves it off (the
 * student floors): that needs a new floor revision, after calibration.
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
  const failClosed = profile.failureMode.classifierUnavailable === "fail_closed";
  const imageModeration = tighten("imageModeration", floor.imageModeration === true, requested.imageModeration, (a, b) => a === b || (failClosed ? !a : a));
  if (imageModeration || floor.imageModeration !== undefined || requested.imageModeration !== undefined) profile.imageModeration = imageModeration;

  const overrides: Record<string, Decision> = { ...floor.actionOverrides };
  for (const [reasonCode, decision] of Object.entries(requested.actionOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const floorDecision = floor.actionOverrides?.[reasonCode];
    overrides[reasonCode] = tighten(`actionOverrides.${reasonCode}`, floorDecision ?? decision, decision, (a, b) => decisionRank(a) >= decisionRank(b));
  }
  if (Object.keys(overrides).length > 0) profile.actionOverrides = overrides;

  // Routing: a family can be switched on but not off, moved from shadow to enforce but not back,
  // and given more evaluation kinds but not fewer. Each only adds evaluation, never removes it.
  if (floor.routing !== undefined || requested.routing !== undefined) {
    const routing: Record<string, FamilyRouting> = {};
    for (const family of MODEL_FAMILIES) {
      const base = familyRouting(floor, family);
      const ask = requested.routing?.[family];
      if (ask === undefined && floor.routing?.[family] === undefined) continue;
      const enabled = tighten(`routing.${family}.enabled`, base.enabled, ask?.enabled, trueWins);
      const mode = tighten(`routing.${family}.mode`, base.mode, ask?.mode, byOrder(["shadow", "enforce"] as const));
      let kinds = base.kinds;
      if (ask?.kinds !== undefined) {
        // A family the floor leaves off can be switched on for any kinds: that only adds evaluation.
        if (!base.enabled) {
          kinds = [...ask.kinds];
        } else if (base.kinds === undefined) {
          violations.push({ field: `routing.${family}.kinds`, floor: "all", requested: ask.kinds.join(",") });
        } else if (base.kinds.every((kind) => ask.kinds!.includes(kind))) {
          kinds = [...ask.kinds];
        } else {
          violations.push({ field: `routing.${family}.kinds`, floor: base.kinds.join(","), requested: ask.kinds.join(",") });
        }
      }
      routing[family] = { enabled, mode, ...(kinds === undefined ? {} : { kinds }) };
    }
    if (Object.keys(routing).length > 0) profile.routing = routing;
  }

  return { profile, violations };
}
