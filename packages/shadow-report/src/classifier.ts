import { CLEF_QUESTIONS, type ClefTransport, createClefClassifier, gatewayFetchTransport } from "@gmacko/hall-monitor-clef";
import { PRICE_BOOK_CLOUDFLARE_2026_10_20, type PriceBook } from "@gmacko/hall-monitor-costing";
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
export function classifierPlugin(choice: ClassifierChoice, priceBook: PriceBook = PRICE_BOOK_CLOUDFLARE_2026_10_20): EvaluatorPlugin | undefined {
  if (choice.kind === "none") return undefined;
  let n = 0;
  return createClefClassifier({
    transport: choice.kind === "fake" ? fakeClefTransport() : choice.transport,
    priceBook,
    newAttemptId: () => `att_shadow_${n++}`,
  });
}
