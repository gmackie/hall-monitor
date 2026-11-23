import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "./cloudflare-2026-10-20.ts";
import { definePriceBook } from "./price-book.ts";

/** Clairic-flash, the fast typed extraction model (early research preview). */
export const CLAIRIC_FLASH_MODEL = "@cf/cloudflare/clairic-flash";
/** Clairic, the typed extraction model (preview), used as Clairic's escalation. */
export const CLAIRIC_MODEL = "@cf/cloudflare/clairic";

const PER_MILLION = "1000000";

/**
 * Cloudflare list prices reviewed on 2026-11-22. It carries every 2026-10-20 rate forward
 * unchanged and adds the Clairic extraction family (see the HM-31 plan).
 *
 * Clairic, like Clef, charges input tokens only. Every `text` field is a separate provider pass
 * that bills the whole input again; receipts use the provider-reported input tokens, which already
 * include every pass, and never estimate them. Clairic's launch price of $0.10 per million input
 * tokens ends on 2026-12-01, when the list price of $0.24 applies: the two rates are effective-dated
 * so an attempt is priced at the rate in force when it was made.
 */
export const PRICE_BOOK_CLOUDFLARE_2026_11_22 = definePriceBook({
  id: "cloudflare-2026-11-22",
  reviewedAt: "2026-11-22T00:00:00Z",
  rates: [
    ...PRICE_BOOK_CLOUDFLARE_2026_10_20.rates.map((rate) => ({ ...rate })),
    {
      rateId: "clairic.input.2026-10-19",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLAIRIC_MODEL,
      unit: "input_tokens",
      // $0.10 per million input tokens: the launch price, until 2026-12-01.
      numeratorUsdNano: "100000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-10-19T00:00:00Z",
      effectiveTo: "2026-12-01T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clairic/",
    },
    {
      rateId: "clairic.input.2026-12-01",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLAIRIC_MODEL,
      unit: "input_tokens",
      // $0.24 per million input tokens: the list price from 2026-12-01.
      numeratorUsdNano: "240000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-12-01T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clairic/",
    },
    {
      rateId: "clairic-flash.input.2026-11-22",
      providerId: CLOUDFLARE_WORKERS_AI,
      sku: CLAIRIC_FLASH_MODEL,
      unit: "input_tokens",
      // $0.10 per million input tokens.
      numeratorUsdNano: "100000000",
      denominator: PER_MILLION,
      effectiveFrom: "2026-11-01T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clairic-flash/",
    },
  ],
});

/** The price book the Worker prices new attempts in. */
export const CURRENT_PRICE_BOOK = PRICE_BOOK_CLOUDFLARE_2026_11_22;

/** A model's place in a family's route and its provider release status. */
export interface ModelRegistryEntry {
  readonly family: "clef" | "clairic";
  readonly modelId: string;
  readonly role: "primary" | "escalation";
  /** `preview` models never enforce unless the owner records a waiver (see the model gate). */
  readonly status: "ga" | "preview";
  readonly providerId: string;
  readonly contextTokens: number;
  readonly modalities: readonly ("text" | "image")[];
}

/**
 * Every model Hall Monitor may call, by family and role. Clef-omni is priced (it is in the 10-20
 * book) but not routed: it adds audio and video, which the API does not accept.
 */
export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = Object.freeze([
  { family: "clef", modelId: CLEF_FLASH_MODEL, role: "primary", status: "ga", providerId: CLOUDFLARE_WORKERS_AI, contextTokens: 24_576, modalities: ["text", "image"] },
  { family: "clef", modelId: CLEF_MODEL, role: "escalation", status: "ga", providerId: CLOUDFLARE_WORKERS_AI, contextTokens: 65_536, modalities: ["text", "image"] },
  { family: "clairic", modelId: CLAIRIC_FLASH_MODEL, role: "primary", status: "preview", providerId: CLOUDFLARE_WORKERS_AI, contextTokens: 65_536, modalities: ["text"] },
  { family: "clairic", modelId: CLAIRIC_MODEL, role: "escalation", status: "preview", providerId: CLOUDFLARE_WORKERS_AI, contextTokens: 65_536, modalities: ["text"] },
].map((entry) => Object.freeze({ ...entry, modalities: Object.freeze([...entry.modalities]) })) as ModelRegistryEntry[]);

/** Every routable model id. */
export const ROUTABLE_MODEL_IDS: readonly string[] = Object.freeze(MODEL_REGISTRY.map((entry) => entry.modelId));

