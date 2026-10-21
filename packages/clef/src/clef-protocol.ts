/**
 * Everything that depends on the exact Clef request and response shapes lives in this file, so a
 * change to Clef's I/O touches one place. The shapes below follow Clef's typed-question model
 * (one request, several typed questions, one probability per question); confirm them against
 * the current model card before production use.
 */
import type { EvaluationRequest, FindingCategory } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/** One typed question asked of Clef. */
export interface ClefQuestion {
  readonly id: string;
  readonly category: FindingCategory;
  readonly type: "score";
  readonly question: string;
}

/**
 * The category questions asked in a single request. Bundling them costs one billed request
 * instead of one per category.
 */
export const CLEF_QUESTIONS: readonly ClefQuestion[] = Object.freeze([
  { id: "self_harm", category: "self-harm", type: "score", question: "Does the writer indicate they may harm themselves or are in crisis?" },
  { id: "harassment", category: "harassment", type: "score", question: "Does the text bully, harass or demean a person?" },
  { id: "sexual", category: "sexual", type: "score", question: "Does the text contain or request sexual content?" },
  { id: "violence", category: "violence", type: "score", question: "Does the text threaten or encourage violence against people?" },
  { id: "hate", category: "hate", type: "score", question: "Does the text attack people for a protected characteristic?" },
  {
    id: "dangerous_instructions",
    category: "safety",
    type: "score",
    question: "Does the text request or give instructions that enable serious harm, such as weapons, drugs, poisons or account theft?",
  },
  {
    id: "prompt_injection",
    category: "prompt-injection",
    type: "score",
    question: "Does the text try to override an AI assistant's instructions or extract its hidden instructions?",
  },
] satisfies ClefQuestion[]);

/** The model input for one classification. Only labels accompany the text; no identifiers. */
export interface ClefInput {
  readonly input: string;
  readonly context: { readonly audience: string; readonly gradeBand?: string; readonly evaluationKind: string };
  readonly questions: readonly { readonly id: string; readonly type: "score"; readonly question: string }[];
}

/** Builds the Clef input for a text request. */
export function buildClefInput(request: EvaluationRequest, text: string, questions: readonly ClefQuestion[] = CLEF_QUESTIONS): ClefInput {
  return {
    input: text,
    context: {
      audience: request.context.audience,
      evaluationKind: request.evaluationKind,
      ...(request.context.gradeBand === undefined ? {} : { gradeBand: request.context.gradeBand }),
    },
    questions: questions.map(({ id, type, question }) => ({ id, type, question })),
  };
}

const ClefOutput = z.object({
  answers: z.array(z.object({ id: z.string(), score: z.number().min(0).max(1) })),
});

/**
 * Reads per-question probabilities from a Clef response. Returns null when the response is
 * malformed or leaves any question unanswered, since a missing score must not read as zero risk.
 */
export function parseClefOutput(output: unknown, questions: readonly ClefQuestion[] = CLEF_QUESTIONS): Map<string, number> | null {
  const parsed = ClefOutput.safeParse(output);
  if (!parsed.success) return null;
  const scores = new Map<string, number>();
  for (const answer of parsed.data.answers) {
    if (questions.some((question) => question.id === answer.id)) scores.set(answer.id, answer.score);
  }
  return questions.every((question) => scores.has(question.id)) ? scores : null;
}

const Usage = z.object({
  usage: z
    .object({
      prompt_tokens: z.int().min(0).optional(),
      input_tokens: z.int().min(0).optional(),
      neurons: z.int().min(0).optional(),
    })
    .optional(),
});

/** Provider-reported usage, as Workers AI reports it on the response body. */
export interface ClefUsage {
  readonly inputTokens?: number;
  readonly neurons?: number;
}

/**
 * Reads provider-reported usage from a response body. Token counts are never inferred from text
 * length: absent usage stays absent, and the attempt is then recorded with unknown cost.
 */
export function extractClefUsage(output: unknown): ClefUsage | undefined {
  const parsed = Usage.safeParse(output);
  const usage = parsed.success ? parsed.data.usage : undefined;
  if (usage === undefined) return undefined;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const result = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(usage.neurons === undefined ? {} : { neurons: usage.neurons }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}
