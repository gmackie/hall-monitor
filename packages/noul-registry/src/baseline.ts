import { CLEF_CLASSIFIER_VERSION, CLEF_IMAGE_QUESTIONS, CLEF_QUESTIONS } from "@gmacko/hall-monitor-clef";
import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import { type DecisionPackPin, parseDecisionPack } from "./definition.ts";

const provenance = {
  ownerRole: "model-evaluation-lead",
  ownerAssignment: "pending",
  ownerRef: null,
  reference: "HM-23; existing Clef classifier 1.1.0; human labeling and acceptance remain HM-8",
};
const fixtureRevision = "wire-baseline-99d4e29";
const negativeCriteria: Readonly<Record<string, string>> = {
  self_harm: "Academic discussion without a personal indication of self-harm or crisis is not by itself a positive.",
  harassment: "Respectful disagreement without bullying, harassment or demeaning a person is not by itself a positive.",
  sexual: "Nonsexual academic discussion without sexual content, requests or nudity is not by itself a positive.",
  violence: "Nonviolent disagreement without threats, encouragement or depictions of violence is not by itself a positive.",
  hate: "Discussion of a protected characteristic without attacking people for it is not by itself a positive.",
  dangerous_instructions: "General safety education without instructions enabling serious harm is not by itself a positive.",
  prompt_injection: "An ordinary task request without overriding or extracting hidden instructions is not by itself a positive.",
};

/** Existing wire prompts are the authority. Descriptive criteria are unvalidated, not new prompts. */
const baseline = parseDecisionPack({
  schemaVersion: "1.0",
  manifest: {
    id: "clef-baseline",
    version: "1.0.0",
    adapter: "clef-1",
    classifierVersion: CLEF_CLASSIFIER_VERSION,
    calibration: "unvalidated",
    fixtureRevision,
    modalities: ["text", "image"],
    providers: [{ id: CLOUDFLARE_WORKERS_AI, modelIds: [CLEF_FLASH_MODEL, CLEF_MODEL] }],
    decisions: CLEF_QUESTIONS.map(({ id }) => ({ id, version: "1.0.0" })),
    provenance,
  },
  definitions: CLEF_QUESTIONS.map((question, index) => ({
    id: question.id,
    version: "1.0.0",
    category: question.category,
    positiveCriteria: [question.instructions, CLEF_IMAGE_QUESTIONS[index]!.instructions],
    negativeCriteria: [negativeCriteria[question.id]],
    requiredContext: ["audience", "evaluationKind"],
    evaluationKinds: EvaluationKind.options,
    questions: [
      { modality: "text", instructions: question.instructions },
      { modality: "image", instructions: CLEF_IMAGE_QUESTIONS[index]!.instructions },
    ],
    providerIds: [CLOUDFLARE_WORKERS_AI],
    fixtureRevision,
    provenance,
  })),
});
if (baseline === undefined) throw new Error("invalid built-in decision pack");
export const BASELINE_DECISION_PACK = baseline;

/** Reviewed bytes, pinned in source. Updating a prompt requires a new pack and explicit pin. */
export const BASELINE_DECISION_PACK_PIN: DecisionPackPin = Object.freeze({
  id: "clef-baseline",
  version: "1.0.0",
  digest: "sha256:42ce98e8c39dc3f368e4e21a516bbb2ac6cd1f278daf272f240da0fd8553ac41",
});
