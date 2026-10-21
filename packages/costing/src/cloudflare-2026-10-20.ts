import { definePriceBook } from "./price-book.ts";

/** Provider id for Cloudflare Workers AI. */
export const CLOUDFLARE_WORKERS_AI = "cloudflare-workers-ai";

/** Clef-flash, the default typed decision model. */
export const CLEF_FLASH_MODEL = "@cf/cloudflare/clef-flash";
/** Clef, the escalation decision model. */
export const CLEF_MODEL = "@cf/cloudflare/clef";
/** Clef-omni, the multimodal decision model. */
export const CLEF_OMNI_MODEL = "@cf/cloudflare/clef-omni";
/** SKU for Workers AI usage billed in neurons rather than per-model tokens. */
export const WORKERS_AI_NEURONS_SKU = "workers-ai-neurons";

const PRICING_PAGE = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
const PER_MILLION = "1000000";

/**
 * Cloudflare list prices reviewed on 2026-10-20 (see 03-PRICING-AND-SCENARIOS §1).
 *
 * The Clef family charges input tokens only; there is no output-token rate, so output tokens are
 * free by omission rather than by a zero rate. Neurons are a separate SKU: Clef token prices and
 * their neuron equivalents are two displays of the same usage and must never both be charged.
 * Gross list rates ignore the account-wide daily free neuron allowance by design.
 */
export const PRICE_BOOK_CLOUDFLARE_2026_10_20 = definePriceBook({
  id: "cloudflare-2026-10-20",
  reviewedAt: "2026-10-20T00:00:00Z",
  rates: [
    {
      rateId: "clef-flash.input.2026-10-09",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLEF_FLASH_MODEL,
      unit: "input_tokens",
      // $0.038 per million input tokens, after the 2026-10-09 price cut.
      numeratorUsdNano: "38000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-10-09T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clef-flash/",
    },
    {
      rateId: "clef.input.2026-10-20",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLEF_MODEL,
      unit: "input_tokens",
      // $0.240 per million input tokens.
      numeratorUsdNano: "240000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: PRICING_PAGE,
    },
    {
      rateId: "clef-omni.input.2026-10-20",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLEF_OMNI_MODEL,
      unit: "input_tokens",
      // $0.150 per million input tokens, after modality tokenization.
      numeratorUsdNano: "150000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clef-omni/",
    },
    {
      rateId: "workers-ai.neurons.2026-10-20",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: WORKERS_AI_NEURONS_SKU,
      unit: "neurons",
      // $0.011 per 1,000 neurons above the shared daily allowance.
      numeratorUsdNano: "11000000",
      denominator: "1000",
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: PRICING_PAGE,
    },
  ],
});
