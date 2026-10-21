import { Audience, Decision, MachineCode, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/** Whether a moderation stage must run, may run, or is skipped. */
export const ModerationMode = z.enum(["required", "optional", "off"]);
/** Whether a moderation stage must run, may run, or is skipped. */
export type ModerationMode = z.infer<typeof ModerationMode>;

/**
 * How directly an assistant may answer: `direct` answers, `contextual` answers unless the work is
 * graded, `scaffolded` always guides the learner to their own attempt.
 */
export const AnswerAssistance = z.enum(["direct", "contextual", "scaffolded"]);
/** How directly an assistant may answer. */
export type AnswerAssistance = z.infer<typeof AnswerAssistance>;

/**
 * What to do when the classifier cannot answer: `fail_closed` holds the request, while
 * `deterministic_only` decides from deterministic findings and reports the result as degraded.
 */
export const ClassifierFailureMode = z.enum(["fail_closed", "deterministic_only"]);
/** What to do when the classifier cannot answer. */
export type ClassifierFailureMode = z.infer<typeof ClassifierFailureMode>;

/** A policy profile: one pinned revision of the rules for an audience and surface. */
export const PolicyProfile = z.object({
  id: OpaqueId,
  revision: OpaqueId,
  audience: Audience,
  studentFacing: z.boolean(),
  inputModeration: ModerationMode,
  outputModeration: ModerationMode,
  answerAssistance: AnswerAssistance,
  escalation: z.object({
    enabled: z.boolean(),
    /** Soft target for the escalated share of evaluations; an alerting threshold, not a cap. */
    maxShare: z.number().min(0).max(1),
  }),
  failureMode: z.object({
    classifierUnavailable: ClassifierFailureMode,
    /** Exhausted safety budgets block generative work; support paths stay available. */
    budgetExhausted: z.literal("block_generative"),
  }),
  /**
   * Whether image content is sent to the classifier. Absent means off: images are then not
   * moderated, which the core resolves like an unavailable classifier under the profile's failure
   * mode (`fail_closed` holds; `deterministic_only` decides from the accompanying text and reports
   * a degraded result), with reason code `hall_monitor.image_moderation_disabled`.
   */
  imageModeration: z.boolean().optional(),
  /**
   * Minimum decisions by reason code. An override can only make a finding's outcome stricter,
   * never more lenient, so it cannot be used to switch a check off.
   */
  actionOverrides: z.record(MachineCode, Decision).optional(),
});
/** A policy profile: one pinned revision of the rules for an audience and surface. */
export type PolicyProfile = z.infer<typeof PolicyProfile>;
