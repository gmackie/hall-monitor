import { EvaluationKind, type EvaluationRequest, type Finding, type Severity, type UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI, type PriceBook, priceAttempt } from "@gmacko/hall-monitor-costing";
import type { EvaluatorPlugin, EvaluatorSignals } from "@gmacko/hall-monitor-evaluators";
import {
  buildClefImageInput,
  buildClefInput,
  CLEF_IMAGE_QUESTIONS,
  CLEF_QUESTIONS,
  type ClefInput,
  clefRequestFor,
  type ClefQuestion,
  parseClefOutput,
} from "./clef-protocol.ts";
import { type ClefTransport, ClefTransportError } from "./transport.ts";

/** Version of this plugin; bump when questions, thresholds or severity mapping change. */
export const CLEF_CLASSIFIER_VERSION = "1.1.0";

/** Default per-call timeout. */
export const DEFAULT_CLEF_TIMEOUT_MS = 2500;

/** Default per-call timeout when the request carries images, which take longer to process. */
export const DEFAULT_CLEF_IMAGE_TIMEOUT_MS = 6000;

/**
 * Probability band treated as ambiguous: below `low` is clear, at or above `high` is a finding,
 * and in between escalates or reports uncertainty.
 *
 * UNCALIBRATED: these are placeholders. They must be replaced with thresholds measured per
 * category and grade band on the frozen corpus before any student rollout.
 */
export const UNCALIBRATED_THRESHOLDS = Object.freeze({ low: 0.35, high: 0.75 });

/** Configuration for {@link createClefClassifier}. */
export interface ClefClassifierOptions {
  readonly transport: ClefTransport;
  /** Prices each attempt; attempts carry this book's id. */
  readonly priceBook: PriceBook;
  /** Generates a unique attempt id. */
  readonly newAttemptId: () => string;
  readonly clock?: () => Date;
  readonly primaryModel?: string;
  readonly escalationModel?: string;
  readonly thresholds?: { readonly low: number; readonly high: number };
  readonly timeoutMs?: number;
  /** Per-call timeout for requests with images. */
  readonly imageTimeoutMs?: number;
  /** Kinds that may escalate; others report ambiguity as uncertainty. */
  readonly escalationKinds?: readonly EvaluationKind[];
  readonly questions?: readonly ClefQuestion[];
  /** Questions for image content; defaults to {@link CLEF_IMAGE_QUESTIONS}. */
  readonly imageQuestions?: readonly ClefQuestion[];
  /** Server-owned transfer guard, rechecked for each primary/escalation call. Denial is not a billed attempt. */
  readonly authorizeModel?: (model: string) => boolean;
}

type CallOutcome =
  | { readonly kind: "scored"; readonly scores: Map<string, number> }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed"; readonly timedOut: boolean };

/**
 * A Clef classifier plugin. It asks Clef-flash every category question in one request and, when
 * any answer falls in the ambiguous band, escalates at most once to Clef if the profile enables
 * escalation for this kind. Every provider call, including failures, yields one priced
 * `UsageAttempt`; a call without reported usage is recorded with unknown cost, never zero.
 *
 * Image content (whose profile allows image moderation; the core checks that) is classified the
 * same way, sending the images with any accompanying text to the same models and asking
 * {@link CLEF_IMAGE_QUESTIONS}. Image tokens are part of the provider-reported input tokens; they
 * are never estimated from image sizes, so a call without reported usage has unknown cost.
 *
 * Failures never produce findings: a timeout, 429 or 5xx sets `classifierUnavailable` (and
 * `classifierTimedOut`), and malformed output sets `uncertain`, leaving the decision to policy.
 */
export function createClefClassifier(options: ClefClassifierOptions): EvaluatorPlugin {
  const primaryModel = options.primaryModel ?? CLEF_FLASH_MODEL;
  const escalationModel = options.escalationModel ?? CLEF_MODEL;
  const { low, high } = options.thresholds ?? UNCALIBRATED_THRESHOLDS;
  if (!(0 <= low && low < high && high <= 1)) throw new RangeError("thresholds must satisfy 0 <= low < high <= 1");
  const textTimeoutMs = options.timeoutMs ?? DEFAULT_CLEF_TIMEOUT_MS;
  const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULT_CLEF_IMAGE_TIMEOUT_MS;
  const escalationKinds = options.escalationKinds ?? ["interaction.input", "content.candidate"];
  const textQuestions = options.questions ?? CLEF_QUESTIONS;
  const imageQuestions = options.imageQuestions ?? CLEF_IMAGE_QUESTIONS;
  const clock = options.clock ?? (() => new Date());

  return {
    id: "clef",
    version: CLEF_CLASSIFIER_VERSION,
    supportedKinds: EvaluationKind.options,
    async evaluate(request, context) {
      let input: ClefInput;
      let questions: readonly ClefQuestion[];
      let timeoutMs: number;
      if (request.content.type === "text") {
        questions = textQuestions;
        input = buildClefInput(request, request.content.text, questions);
        timeoutMs = textTimeoutMs;
      } else if (request.content.type === "image") {
        questions = imageQuestions;
        input = buildClefImageInput(request, request.content, questions);
        timeoutMs = imageTimeoutMs;
      } else {
        return { findings: [], attempts: [] };
      }
      const attempts: UsageAttempt[] = [];

      const call = async (model: string): Promise<CallOutcome> => {
        if (options.authorizeModel !== undefined && !options.authorizeModel(model)) return { kind: "failed", timedOut: false };
        const attemptIndex = attempts.length;
        try {
          const result = await runWithTimeout(options.transport, model, clefRequestFor(model, input), timeoutMs, context.signal);
          attempts.push(
            price({
              attemptId: options.newAttemptId(),
              attemptIndex,
              providerId: CLOUDFLARE_WORKERS_AI,
              modelId: model,
              sku: model,
              priceBookId: options.priceBook.id,
              units: { ...result.usage },
              state: result.usage?.inputTokens === undefined ? "unknown" : "provider_reported",
              ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
              ...(result.gatewayLogId === undefined ? {} : { gatewayLogId: result.gatewayLogId }),
            }),
          );
          const scores = parseClefOutput(result.output, questions);
          return scores === null ? { kind: "malformed" } : { kind: "scored", scores };
        } catch (error) {
          // The provider may have processed (and billed) a request we gave up on.
          attempts.push(
            price({
              attemptId: options.newAttemptId(),
              attemptIndex,
              providerId: CLOUDFLARE_WORKERS_AI,
              modelId: model,
              sku: model,
              priceBookId: options.priceBook.id,
              units: {},
              state: "unknown",
            }),
          );
          return { kind: "failed", timedOut: error instanceof ClefTimeoutError };
        }
      };
      const price = (attempt: UsageAttempt) => priceAttempt(options.priceBook, attempt, { at: clock() }).attempt;
      const ambiguous = (scores: Map<string, number>) => [...scores.values()].some((score) => score >= low && score < high);

      const primary = await call(primaryModel);
      if (primary.kind === "failed") {
        return { findings: [], attempts, signals: { classifierUnavailable: true, ...(primary.timedOut ? { classifierTimedOut: true } : {}) } };
      }
      if (primary.kind === "malformed") return { findings: [], attempts, signals: { uncertain: true } };

      let scores = primary.scores;
      let fellBack = false;
      if (ambiguous(scores) && context.profile.escalation.enabled && escalationKinds.includes(request.evaluationKind)) {
        const escalated = await call(escalationModel);
        if (escalated.kind === "scored") scores = escalated.scores;
        else fellBack = true;
      }

      const findings = questions.flatMap((question): Finding[] => {
        const score = scores.get(question.id)!;
        return score >= high
          ? [
              {
                evaluatorId: "clef",
                evaluatorVersion: CLEF_CLASSIFIER_VERSION,
                category: question.category,
                reasonCode: `clef.${question.id}`,
                severity: severityFor(question, request),
                confidence: score,
              },
            ]
          : [];
      });
      const signals: EvaluatorSignals = fellBack || ambiguous(scores) ? { uncertain: true } : {};
      return { findings, attempts, signals };
    },
  };
}

/** Thrown when a call exceeds its timeout. */
class ClefTimeoutError extends Error {
  override readonly name = "ClefTimeoutError";
}

function severityFor(question: ClefQuestion, request: EvaluationRequest): Severity {
  const studentFacing = request.context.audience === "student";
  switch (question.category) {
    case "self-harm":
      return "support";
    case "harassment":
      return "hold";
    case "prompt-injection":
      return studentFacing && request.evaluationKind === "interaction.input" ? "block" : "hold";
    default:
      return studentFacing ? "block" : "hold";
  }
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
      reject(new ClefTimeoutError(`Clef call exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([transport.run(model, input, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}
