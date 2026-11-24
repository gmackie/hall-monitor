import { type ClefTransport, ClefTransportError } from "@gmacko/hall-monitor-clef";
import { EvaluationKind, type EvaluationRequest, type Evidence, type Finding, type ModelCall, type ModelCallRole, type UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { CLAIRIC_FLASH_MODEL, CLAIRIC_MODEL, CLOUDFLARE_WORKERS_AI, type PriceBook, priceAttempt } from "@gmacko/hall-monitor-costing";
import type { ClassifierTrace, EvaluatorPlugin, EvaluatorSignals } from "@gmacko/hall-monitor-evaluators";
import { buildClairicInput, type ClairicAnswer, type ClairicField, CLAIRIC_FIELDS, fieldsFor, parseClairicOutput } from "./protocol.ts";

/** Version of this evaluator; bump when fields, thresholds or the finding mapping change. */
export const CLAIRIC_EVALUATOR_VERSION = "0.1.0";
/** The model family this evaluator reports in a result's route. */
export const CLAIRIC_FAMILY = "clairic";
/** Default per-call timeout. Clairic makes one provider pass per text field, so it is slower than Clef. */
export const DEFAULT_CLAIRIC_TIMEOUT_MS = 4000;

/**
 * Confidence band treated as uncertain: an answer below `low` is not relied on, at or above `high`
 * it can produce a finding, and in between it escalates (or reports uncertainty).
 *
 * UNCALIBRATED, like Clef's: placeholders until held-out calibration replaces them per cohort.
 */
export const UNCALIBRATED_CLAIRIC_THRESHOLDS = Object.freeze({ low: 0.35, high: 0.75 });

/** Reason codes this evaluator emits. All reuse existing finding categories, so older clients parse them. */
export const CLAIRIC_REASON_CODES = Object.freeze({
  personalIdentifier: "clairic.personal_identifier",
  answerLeakage: "clairic.answer_leakage",
  evaluatorInconsistent: "clairic.evaluator_inconsistent",
  claims: "clairic.claims",
});

/** Configuration for {@link createClairicEvaluator}. */
export interface ClairicEvaluatorOptions {
  /** Any Workers AI transport; the Clef package's binding and gateway transports work unchanged. */
  readonly transport: ClefTransport;
  readonly priceBook: PriceBook;
  readonly newAttemptId: () => string;
  readonly clock?: () => Date;
  readonly primaryModel?: string;
  readonly escalationModel?: string;
  readonly thresholds?: { readonly low: number; readonly high: number };
  readonly timeoutMs?: number;
  readonly fields?: readonly ClairicField[];
  /** Kinds that may escalate to the full model; defaults to every kind. */
  readonly escalationKinds?: readonly EvaluationKind[];
  /** Server-owned transfer guard, checked before every call. A denial is never billed. */
  readonly authorizeModel?: (model: string) => boolean;
}

type CallOutcome =
  | { readonly kind: "scored"; readonly answers: Map<string, ClairicAnswer> }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed"; readonly timedOut: boolean };

/**
 * A Clairic evaluator plugin. It asks Clairic-flash the typed fields that apply to the request in
 * one call and escalates at most once to Clairic when any relied-on answer's confidence is in the
 * uncertain band and the profile enables escalation. Every provider call yields one priced
 * `UsageAttempt` from the provider-reported input tokens (which count every pass).
 *
 * Findings carry spans and evidence, never the extracted text. Clairic reads text only; images and
 * digests are declined through `supportsContent`, so the core records the family as skipped.
 * Routing is the profile's: Clairic is in preview, so profiles run it in shadow until it passes the
 * model gate (see `docs/implementation/clairic.md`).
 */
export function createClairicEvaluator(options: ClairicEvaluatorOptions): EvaluatorPlugin {
  const primaryModel = options.primaryModel ?? CLAIRIC_FLASH_MODEL;
  const escalationModel = options.escalationModel ?? CLAIRIC_MODEL;
  const { low, high } = options.thresholds ?? UNCALIBRATED_CLAIRIC_THRESHOLDS;
  if (!(0 <= low && low < high && high <= 1)) throw new RangeError("thresholds must satisfy 0 <= low < high <= 1");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAIRIC_TIMEOUT_MS;
  const escalationKinds = options.escalationKinds ?? EvaluationKind.options;
  const clock = options.clock ?? (() => new Date());
  const allFields = options.fields ?? CLAIRIC_FIELDS;

  return {
    id: "clairic",
    family: CLAIRIC_FAMILY,
    version: CLAIRIC_EVALUATOR_VERSION,
    supportedKinds: EvaluationKind.options,
    supportsContent: (request) => request.content.type === "text",
    async evaluate(request, context) {
      if (request.content.type !== "text") return { findings: [], attempts: [] };
      const fields = fieldsFor(request, allFields);
      const textLength = request.content.text.length;
      const attempts: UsageAttempt[] = [];
      const calls: ModelCall[] = [];
      const trace = (extra: Partial<ClassifierTrace> = {}): ClassifierTrace => ({ family: CLAIRIC_FAMILY, calibrationRevision: null, calls: [...calls], escalated: false, ...extra });
      if (fields.length === 0) return { findings: [], attempts, trace: trace() };

      const price = (attempt: UsageAttempt) => priceAttempt(options.priceBook, attempt, { at: clock() }).attempt;
      const call = async (model: string, role: ModelCallRole): Promise<CallOutcome> => {
        if (options.authorizeModel !== undefined && !options.authorizeModel(model)) {
          calls.push({ modelId: model, role, outcome: "denied" });
          return { kind: "failed", timedOut: false };
        }
        const attemptIndex = attempts.length;
        const attemptId = options.newAttemptId();
        const base = { attemptId, attemptIndex, providerId: CLOUDFLARE_WORKERS_AI, modelId: model, sku: model, priceBookId: options.priceBook.id };
        try {
          const result = await runWithTimeout(options.transport, model, buildClairicInput(model, request, fields), timeoutMs, context.signal);
          attempts.push(price({
            ...base,
            units: { ...result.usage },
            state: result.usage?.inputTokens === undefined ? "unknown" : "provider_reported",
            ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
            ...(result.gatewayLogId === undefined ? {} : { gatewayLogId: result.gatewayLogId }),
          }));
          const answers = parseClairicOutput(result.output, fields, textLength);
          calls.push({ modelId: model, role, outcome: answers === null ? "malformed" : "scored", attemptId });
          return answers === null ? { kind: "malformed" } : { kind: "scored", answers };
        } catch (error) {
          attempts.push(price({ ...base, units: {}, state: "unknown" }));
          const timedOut = error instanceof ClairicTimeoutError;
          calls.push({ modelId: model, role, outcome: timedOut ? "timed_out" : "failed", attemptId });
          return { kind: "failed", timedOut };
        }
      };
      const uncertain = (answers: Map<string, ClairicAnswer>) =>
        [...answers.values()].some((answer) => answer.confidence !== undefined && answer.confidence >= low && answer.confidence < high);

      const primary = await call(primaryModel, "primary");
      if (primary.kind === "failed") {
        return { findings: [], attempts, signals: { classifierUnavailable: true, ...(primary.timedOut ? { classifierTimedOut: true } : {}) }, trace: trace() };
      }
      if (primary.kind === "malformed") return { findings: [], attempts, signals: { uncertain: true }, trace: trace() };

      let answers = primary.answers;
      let escalated = false;
      let fellBack = false;
      if (uncertain(answers) && context.profile.escalation.enabled && escalationKinds.includes(request.evaluationKind)) {
        escalated = true;
        const outcome = await call(escalationModel, "escalation");
        if (outcome.kind === "scored") answers = outcome.answers;
        else fellBack = true;
      }
      const findings = findingsFor(request, answers, high);
      const signals: EvaluatorSignals = fellBack || uncertain(answers) ? { uncertain: true } : {};
      return {
        findings,
        attempts,
        signals,
        trace: trace({ escalated, ...(escalated ? { escalationReason: "low_confidence" as const } : {}), ...(fellBack ? { fellBack } : {}) }),
      };
    },
  };
}

/** Turns confident answers into content-free findings with located evidence. */
export function findingsFor(request: EvaluationRequest, answers: ReadonlyMap<string, ClairicAnswer>, high: number = UNCALIBRATED_CLAIRIC_THRESHOLDS.high): Finding[] {
  const student = request.context.audience === "student";
  const confident = (answer: ClairicAnswer | undefined): answer is ClairicAnswer => answer !== undefined && (answer.confidence ?? 0) >= high;
  const evidence = (field: string, answer: ClairicAnswer): Evidence[] =>
    answer.spans.slice(0, 16).map((span) => ({ field, span, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) }));
  const finding = (draft: Omit<Finding, "evaluatorId" | "evaluatorVersion">): Finding => ({ evaluatorId: "clairic", evaluatorVersion: CLAIRIC_EVALUATOR_VERSION, ...draft });
  const findings: Finding[] = [];

  const identifiers = answers.get("personal_identifiers");
  if (confident(identifiers) && Array.isArray(identifiers.value) && identifiers.value.length > 0) {
    const located = evidence("personal_identifier", identifiers);
    findings.push(finding({
      category: "privacy",
      reasonCode: CLAIRIC_REASON_CODES.personalIdentifier,
      severity: student ? "hold" : "info",
      confidence: identifiers.confidence!,
      ...(located[0]?.span === undefined ? {} : { span: located[0].span }),
      ...(located.length === 0 ? {} : { evidence: located }),
    }));
  }

  const reveals = answers.get("reveals_answer");
  if (confident(reveals) && reveals.value === true) {
    const stated = answers.get("stated_answers");
    const located = stated === undefined ? [] : evidence("stated_answer", stated);
    findings.push(finding({
      category: "academic-integrity",
      reasonCode: CLAIRIC_REASON_CODES.answerLeakage,
      severity: student ? "hold" : "info",
      confidence: reveals.confidence!,
      ...(located[0]?.span === undefined ? {} : { span: located[0].span }),
      ...(located.length === 0 ? {} : { evidence: located }),
    }));
  }

  const consistent = answers.get("score_matches_verdict");
  if (request.evaluationKind === "assessment.evaluator-result" && confident(consistent) && consistent.value === false) {
    const located = [
      ...evidence("stated_score", answers.get("stated_score") ?? { value: null, spans: [] }),
      ...evidence("stated_verdict", answers.get("states_pass") ?? { value: null, spans: [] }),
    ].slice(0, 16);
    findings.push(finding({
      category: "quality",
      reasonCode: CLAIRIC_REASON_CODES.evaluatorInconsistent,
      severity: "hold",
      confidence: consistent.confidence!,
      ...(located.length === 0 ? {} : { evidence: located }),
    }));
  }

  const claims = answers.get("factual_claims");
  if (confident(claims) && Array.isArray(claims.value) && claims.value.length > 0) {
    const located = evidence("factual_claim", claims);
    findings.push(finding({
      category: "quality",
      reasonCode: CLAIRIC_REASON_CODES.claims,
      severity: "info",
      confidence: claims.confidence!,
      ...(located.length === 0 ? {} : { evidence: located }),
    }));
  }
  return findings;
}

class ClairicTimeoutError extends Error {
  override readonly name = "ClairicTimeoutError";
}

async function runWithTimeout(transport: ClefTransport, model: string, input: unknown, timeoutMs: number, parent: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) throw new ClefTransportError("unavailable");
  parent.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClairicTimeoutError(`Clairic call exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([transport.run(model, input, { signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}
