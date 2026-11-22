import { z } from "zod";
import { Finding } from "./finding.ts";
import { MachineCode, OpaqueId } from "./primitives.ts";

/**
 * How a model family's findings are used: `enforce` feeds them to the decision; `shadow` records
 * them in {@link ClassifierRoute.shape.shadowFindings} without affecting the decision. This is the
 * family's mode under the pinned profile, independent of the tenant's enforcement mode.
 */
export const FamilyMode = z.enum(["enforce", "shadow"]);
/** How a model family's findings are used. */
export type FamilyMode = z.infer<typeof FamilyMode>;

/** Which step of a family's route a model call was. */
export const ModelCallRole = z.enum(["primary", "escalation"]);
/** Which step of a family's route a model call was. */
export type ModelCallRole = z.infer<typeof ModelCallRole>;

/**
 * What came of one model call: `scored` (a usable answer), `malformed` (an answer that did not
 * match the protocol), `failed` (a provider error), `timed_out`, or `denied` (governance refused
 * the transfer, so nothing was sent and nothing was billed).
 */
export const ModelCallOutcome = z.enum(["scored", "malformed", "failed", "timed_out", "denied"]);
/** What came of one model call. */
export type ModelCallOutcome = z.infer<typeof ModelCallOutcome>;

/** One model call on a family's route, in order. */
export const ModelCall = z.object({
  modelId: z.string().min(1).max(128),
  role: ModelCallRole,
  outcome: ModelCallOutcome,
  /** The matching `receipt.attempts[].attemptId`; absent for a denied call, which is never billed. */
  attemptId: OpaqueId.optional(),
});
/** One model call on a family's route. */
export type ModelCall = z.infer<typeof ModelCall>;

/**
 * Why a family did not run for this evaluation:
 * - `moderation_off`: the profile does not moderate this stage.
 * - `deterministic_decisive`: a deterministic block or support finding already decided it.
 * - `digest_content`: digest content cannot be classified.
 * - `image_moderation_disabled`: images under a profile without image moderation.
 * - `budget_exhausted`: the safety budget refused the spend.
 * - `kind_not_routed`: the family does not handle this evaluation kind.
 * - `profile_disabled`: the profile's routing turns the family off.
 * - `not_authorized`: governance refused every model on the route.
 */
export const ClassifierSkipReason = z.enum([
  "moderation_off",
  "deterministic_decisive",
  "digest_content",
  "image_moderation_disabled",
  "budget_exhausted",
  "kind_not_routed",
  "profile_disabled",
  "not_authorized",
]);
/** Why a family did not run for this evaluation. */
export type ClassifierSkipReason = z.infer<typeof ClassifierSkipReason>;

/** Why a family escalated from its primary to its escalation model. */
export const EscalationReason = z.enum(["ambiguous_band", "low_confidence"]);
/** Why a family escalated. */
export type EscalationReason = z.infer<typeof EscalationReason>;

/** The path one model family took for an evaluation. */
export const ClassifierRoute = z.object({
  /** The model family, e.g. `clef` or `clairic`. */
  family: MachineCode,
  evaluatorId: OpaqueId,
  evaluatorVersion: OpaqueId,
  status: z.enum(["ran", "skipped"]),
  skipReason: ClassifierSkipReason.optional(),
  mode: FamilyMode,
  /** The calibration revision whose bands were applied; null for the uncalibrated defaults. */
  calibrationRevision: OpaqueId.nullable(),
  calls: z.array(ModelCall).max(16),
  escalated: z.boolean(),
  escalationReason: EscalationReason.optional(),
  /** True when escalation was wanted but failed or was refused, so the primary answer was kept and marked uncertain. */
  fellBack: z.boolean().optional(),
  /** Findings of a family in `shadow` mode, recorded for review and never used for the decision. */
  shadowFindings: z.array(Finding).max(64).optional(),
});
/** The path one model family took for an evaluation. */
export type ClassifierRoute = z.infer<typeof ClassifierRoute>;

/**
 * Which model families ran, which models they called, and whether they escalated. It names models
 * and outcomes only and links calls to receipt attempts, so a product can show "clef-flash →
 * clef (escalated: ambiguous)" next to the cost without inferring it from the receipt.
 */
export const EvaluationRoute = z.object({
  classifiers: z.array(ClassifierRoute).max(8),
});
/** Which model families ran and how. */
export type EvaluationRoute = z.infer<typeof EvaluationRoute>;
