import { Audience, EvaluationKind, GradeBand, OpaqueId, type EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import type { PolicyProfile } from "@gmacko/hall-monitor-policy";
import { z } from "zod";
import type { ClefQuestion } from "./clef-protocol.ts";

export const CalibrationLanguage = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(64);
export const CalibrationCohort = z.strictObject({
  profileId: OpaqueId, profileRevision: OpaqueId, gradeBand: GradeBand, language: CalibrationLanguage,
  modality: z.enum(["text", "image"]), evaluationKind: EvaluationKind, audience: Audience,
});
export type CalibrationCohort = z.infer<typeof CalibrationCohort>;
export const CalibrationBand = z.strictObject({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
  .refine((band) => band.low < band.high);
export type CalibrationBand = z.infer<typeof CalibrationBand>;

const Row = z.strictObject({
  providerId: z.literal(CLOUDFLARE_WORKERS_AI), modelId: z.string().min(1).max(128), cohort: CalibrationCohort,
  questions: z.array(z.strictObject({ id: OpaqueId, instructions: z.string().min(1).max(2048), band: CalibrationBand })).min(1).max(64),
});
const Selection = z.strictObject({
  schemaVersion: z.literal("1.0"), revision: OpaqueId.max(80),
  /** Explicit trusted/offline context. EvaluationRequest carries no language; never infer one. */
  language: CalibrationLanguage.nullable(), rows: z.array(Row).max(4000),
});
export type ClefCalibrationSelection = z.infer<typeof Selection>;

const cohortKey = (c: CalibrationCohort) => JSON.stringify([c.profileId, c.profileRevision, c.gradeBand, c.language, c.modality, c.evaluationKind, c.audience]);

/** Structural validation only. Approval, installation and activation belong to the server owner. */
export function parseClefCalibration(input: unknown): ClefCalibrationSelection | undefined {
  const parsed = Selection.safeParse(input);
  if (!parsed.success) return undefined;
  const rows = parsed.data.rows;
  const keys = rows.map((r) => JSON.stringify([r.providerId, r.modelId, cohortKey(r.cohort)]));
  if (new Set(keys).size !== keys.length || rows.some((r) => new Set(r.questions.map((q) => q.id)).size !== r.questions.length)) return undefined;
  return freeze(parsed.data);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}

/** Whole-model selection. Missing context, bands or changed question bytes decline the call. */
export function selectClefCalibration(
  selection: ClefCalibrationSelection, modelId: string, request: EvaluationRequest,
  profile: PolicyProfile, questions: readonly ClefQuestion[],
): ReadonlyMap<string, CalibrationBand> | undefined {
  if (selection.language === null || request.context.gradeBand === undefined ||
      (request.content.type !== "text" && request.content.type !== "image") ||
      request.policy.profileId !== profile.id || request.policy.revision !== profile.revision || request.context.audience !== profile.audience) return undefined;
  const cohort: CalibrationCohort = { profileId: profile.id, profileRevision: profile.revision, gradeBand: request.context.gradeBand,
    language: selection.language, modality: request.content.type, evaluationKind: request.evaluationKind, audience: request.context.audience };
  const row = selection.rows.find((r) => r.modelId === modelId && cohortKey(r.cohort) === cohortKey(cohort));
  if (row === undefined || row.questions.length !== questions.length || questions.some((q, i) =>
    row.questions[i]?.id !== q.id || row.questions[i]?.instructions !== q.instructions)) return undefined;
  return new Map(row.questions.map((q) => [q.id, q.band]));
}
