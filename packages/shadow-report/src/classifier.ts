import { CLEF_QUESTIONS, type ClefTransport, createClefClassifier, gatewayFetchTransport } from "@gmacko/hall-monitor-clef";
import { createClairicEvaluator } from "@gmacko/hall-monitor-clairic";
import { CURRENT_PRICE_BOOK, type PriceBook } from "@gmacko/hall-monitor-costing";
import type { EvaluatorPlugin } from "@gmacko/hall-monitor-evaluators";

/**
 * Which classifier a shadow run uses: none (deterministic only), a fake that answers locally, or a
 * real Clef transport. A real transport is billed; use it with synthetic cases only.
 */
export type ClassifierChoice =
  | { readonly kind: "none" }
  | { readonly kind: "fake" }
  | { readonly kind: "transport"; readonly label: "gateway"; readonly transport: ClefTransport };

/** The report label of a classifier choice. */
export function classifierLabel(choice: ClassifierChoice): "none" | "fake" | "gateway" {
  return choice.kind === "transport" ? choice.label : choice.kind;
}

/**
 * A local stand-in for Clef: every question is answered clearly "no" (0.02), so decisions come
 * from the deterministic bundle and policy, and usage is a deterministic estimate of four
 * characters per input token. It exercises the classifier path, receipts and cost arithmetic
 * without a network call; its costs are simulated, not measured.
 */
export function fakeClefTransport(): ClefTransport {
  return {
    async run(model, input) {
      const answers = Object.fromEntries(CLEF_QUESTIONS.map((question) => [question.id, { type: "noul", noul: 0.02 }]));
      const inputTokens = Math.ceil(JSON.stringify(input).length / 4);
      return {
        output: { model: model.slice(model.lastIndexOf("/") + 1), answers, usage: { input_tokens: inputTokens, output_tokens: CLEF_QUESTIONS.length } },
        usage: { inputTokens, outputTokens: CLEF_QUESTIONS.length },
      };
    },
  };
}

/** Settings for a real Clef transport through AI Gateway, read from the environment by the CLI. */
export interface GatewaySettings {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly token: string;
}

/** A billed Clef transport through AI Gateway with payload logging off. */
export function gatewayClassifier(settings: GatewaySettings): ClassifierChoice {
  return {
    kind: "transport",
    label: "gateway",
    transport: gatewayFetchTransport({ ...settings, collectLogPayload: false, metadata: { purpose: "shadow-report" } }),
  };
}

/** The classifier plugin for a choice, or undefined for `none`. */
export function classifierPlugin(choice: ClassifierChoice, priceBook: PriceBook = CURRENT_PRICE_BOOK): EvaluatorPlugin | undefined {
  if (choice.kind === "none") return undefined;
  let n = 0;
  return createClefClassifier({
    transport: choice.kind === "fake" ? fakeClefTransport() : choice.transport,
    priceBook,
    newAttemptId: () => `att_shadow_${n++}`,
  });
}

/**
 * A local stand-in for Clairic: every requested field is answered "nothing found" with high
 * confidence, and usage is the same four-characters-per-token estimate as the fake Clef, so a
 * family diff isolates routing and cost rather than model behaviour.
 */
export function fakeClairicTransport(): ClefTransport {
  return {
    async run(_model, input) {
      const fields = (input as { fields?: Record<string, { type: string }> }).fields ?? {};
      const answers = Object.fromEntries(Object.entries(fields).map(([id, spec]) => [id, { value: spec.type === "list" ? [] : spec.type === "boolean" ? false : null, confidence: 0.95 }]));
      const inputTokens = Math.ceil(JSON.stringify(input).length / 4) * Math.max(1, Object.keys(fields).length);
      return { output: { answers, usage: { input_tokens: inputTokens } }, usage: { inputTokens } };
    },
  };
}

/**
 * The further model families for a choice: Clairic, through the same transport kind as Clef. They
 * run only where a variant's profile routing enables them, so built-in variants are unaffected.
 */
export function familyPlugins(choice: ClassifierChoice, priceBook: PriceBook = CURRENT_PRICE_BOOK): EvaluatorPlugin[] {
  if (choice.kind === "none") return [];
  let n = 0;
  return [createClairicEvaluator({
    transport: choice.kind === "fake" ? fakeClairicTransport() : choice.transport,
    priceBook,
    newAttemptId: () => `att_shadow_clairic_${n++}`,
  })];
}
