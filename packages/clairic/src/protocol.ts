import type { EvaluationKind, EvaluationRequest, Span } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/**
 * One typed extraction field, in Clairic's request shape. Only the types Hall Monitor uses are
 * modelled: `list` of `text` items (identifiers, answers, claims), `boolean` and `number`.
 */
export type ClairicFieldSpec =
  | { readonly type: "list"; readonly instructions: string; readonly items: { readonly type: "text" } }
  | { readonly type: "boolean"; readonly instructions: string }
  | { readonly type: "number"; readonly instructions: string; readonly min?: number; readonly max?: number };

/** A field Hall Monitor asks for, with the evaluation kinds it applies to. */
export interface ClairicField {
  readonly id: string;
  readonly spec: ClairicFieldSpec;
  readonly kinds: readonly EvaluationKind[];
  /** Only when the request carries an answer key. */
  readonly needsAnswerKey?: boolean;
}

const TEXT_KINDS: readonly EvaluationKind[] = ["interaction.input", "interaction.output", "content.candidate", "assessment.evaluator-result"];

/**
 * The fields Clairic is asked, by purpose (see the HM-32 plan): located personal identifiers for
 * every text kind; answer extraction and leakage when an answer key is supplied; verdict, score
 * and consistency for evaluator results; and factual claims in candidate content.
 */
export const CLAIRIC_FIELDS: readonly ClairicField[] = Object.freeze([
  {
    id: "personal_identifiers",
    kinds: TEXT_KINDS,
    spec: {
      type: "list",
      items: { type: "text" },
      instructions:
        "Every detail that identifies a real private person: full names, usernames or handles, home or street addresses, phone numbers, email addresses, school names together with a class or grade, or account numbers. Exclude public figures and fictional characters.",
    },
  },
  {
    id: "stated_answers",
    kinds: ["interaction.output", "assessment.evaluator-result"],
    needsAnswerKey: true,
    spec: { type: "list", items: { type: "text" }, instructions: "Every final answer the text states outright for the task, as written." },
  },
  {
    id: "reveals_answer",
    kinds: ["interaction.output", "assessment.evaluator-result"],
    needsAnswerKey: true,
    spec: { type: "boolean", instructions: "Does the text state any of the expected answers outright instead of guiding the learner toward it?" },
  },
  {
    id: "stated_score",
    kinds: ["assessment.evaluator-result"],
    spec: { type: "number", min: 0, max: 100, instructions: "The score the evaluator awarded, as a percentage of the maximum. Null when no score is stated." },
  },
  {
    id: "states_pass",
    kinds: ["assessment.evaluator-result"],
    spec: { type: "boolean", instructions: "Does the evaluator state that the work passes or meets the standard?" },
  },
  {
    id: "score_matches_verdict",
    kinds: ["assessment.evaluator-result"],
    spec: { type: "boolean", instructions: "Are the stated score, the stated verdict and the stated reasons consistent with one another?" },
  },
  {
    id: "factual_claims",
    kinds: ["content.candidate"],
    spec: { type: "list", items: { type: "text" }, instructions: "Every checkable factual claim the text makes, one per item, as written." },
  },
] satisfies ClairicField[]);

/** The fields that apply to a request. */
export function fieldsFor(request: EvaluationRequest, fields: readonly ClairicField[] = CLAIRIC_FIELDS): ClairicField[] {
  const answerKey = request.content.type === "text" && (request.content.answerKey?.length ?? 0) > 0;
  return fields.filter((field) => field.kinds.includes(request.evaluationKind) && (field.needsAnswerKey !== true || answerKey));
}

/** Clairic's request body. `state` is the evaluated text alone, so returned spans index into it. */
export interface ClairicInput {
  readonly model: "clairic" | "clairic-flash";
  readonly state: string;
  readonly fields: Readonly<Record<string, ClairicFieldSpec>>;
}

/**
 * Builds the request for `model`. The answer key, when needed, goes into the field instructions
 * rather than `state`, so spans stay offsets into the evaluated text.
 */
export function buildClairicInput(model: string, request: EvaluationRequest, fields: readonly ClairicField[]): ClairicInput {
  const selector = model.slice(model.lastIndexOf("/") + 1);
  if (selector !== "clairic" && selector !== "clairic-flash") throw new RangeError(`not a Clairic model: ${model}`);
  if (request.content.type !== "text") throw new RangeError("Clairic reads text content only");
  const answerKey = request.content.answerKey ?? [];
  const specs: Record<string, ClairicFieldSpec> = {};
  for (const field of fields) {
    specs[field.id] = field.needsAnswerKey === true
      ? { ...field.spec, instructions: `${field.spec.instructions} Expected answers: ${answerKey.map((answer) => JSON.stringify(answer)).join("; ")}.` }
      : field.spec;
  }
  return { model: selector, state: request.content.text, fields: specs };
}

/** One field's answer: its value, how sure the model is, and where in the text it came from. */
export interface ClairicAnswer {
  readonly value: unknown;
  readonly confidence?: number;
  readonly pNull?: number;
  readonly spans: readonly Span[];
}

const RawSpan = z.union([
  z.object({ start: z.int().min(0), end: z.int().min(0) }),
  z.tuple([z.int().min(0), z.int().min(0)]),
]);
const RawAnswer = z.object({
  value: z.unknown().optional(),
  confidence: z.number().min(0).max(1).optional(),
  p_null: z.number().min(0).max(1).optional(),
  span: RawSpan.nullish(),
  spans: z.array(RawSpan).nullish(),
});
const RawOutput = z.object({
  answers: z.union([
    z.record(z.string(), RawAnswer),
    z.array(RawAnswer.extend({ field: z.string().optional(), name: z.string().optional(), id: z.string().optional() })),
  ]),
});

/**
 * Reads Clairic's answers for `fields`. Returns null when the response is malformed or leaves a
 * field unanswered, since a missing answer must not read as "nothing found". Spans outside the
 * evaluated text are dropped; spans nested in list items (`value[i].span(s)`) are collected too.
 */
export function parseClairicOutput(output: unknown, fields: readonly ClairicField[], textLength: number): Map<string, ClairicAnswer> | null {
  const parsed = RawOutput.safeParse(output);
  if (!parsed.success) return null;
  const byField = new Map<string, z.infer<typeof RawAnswer>>();
  if (Array.isArray(parsed.data.answers)) {
    for (const answer of parsed.data.answers) {
      const key = answer.field ?? answer.name ?? answer.id;
      if (key !== undefined) byField.set(key, answer);
    }
  } else {
    for (const [key, answer] of Object.entries(parsed.data.answers)) byField.set(key, answer);
  }
  const answers = new Map<string, ClairicAnswer>();
  for (const field of fields) {
    const raw = byField.get(field.id);
    if (raw === undefined) return null;
    const spans: Span[] = [];
    const take = (candidate: unknown) => {
      const span = RawSpan.safeParse(candidate);
      if (!span.success) return;
      const [start, end] = Array.isArray(span.data) ? span.data : [span.data.start, span.data.end];
      if (start <= end && end <= textLength && spans.length < 16) spans.push({ start, end });
    };
    take(raw.span);
    for (const span of raw.spans ?? []) take(span);
    if (Array.isArray(raw.value)) {
      for (const item of raw.value) {
        if (typeof item === "object" && item !== null) {
          take((item as { span?: unknown }).span);
          for (const span of ((item as { spans?: unknown }).spans as unknown[] | undefined) ?? []) take(span);
        }
      }
    }
    answers.set(field.id, {
      value: raw.value ?? null,
      ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
      ...(raw.p_null === undefined ? {} : { pNull: raw.p_null }),
      spans,
    });
  }
  return answers;
}
