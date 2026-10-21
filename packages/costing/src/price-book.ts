import { NonNegativeUsdNano, OpaqueId, Timestamp } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import type { Rational } from "./usd-nano.ts";

/** The usage counter a rate charges for. */
export const RateUnit = z.enum(["input_tokens", "cached_input_tokens", "output_tokens", "neurons", "requests"]);
/** The usage counter a rate charges for. */
export type RateUnit = z.infer<typeof RateUnit>;

/**
 * One list price: `numeratorUsdNano` nanodollars per `denominator` units of `unit` for `sku`.
 * Rates are rational so prices such as $0.038 per million tokens are exact.
 */
export const PriceRate = z
  .object({
    rateId: OpaqueId,
    providerId: OpaqueId,
    /** The billable SKU; for models this is the model id. */
    sku: z.string().min(1).max(128),
    unit: RateUnit,
    numeratorUsdNano: NonNegativeUsdNano,
    denominator: z.string().regex(/^[1-9]\d*$/),
    effectiveFrom: Timestamp,
    effectiveTo: Timestamp.optional(),
    sourceUrl: z.url({ protocol: /^https$/ }),
  })
  .refine((rate) => rate.effectiveTo === undefined || Date.parse(rate.effectiveTo) > Date.parse(rate.effectiveFrom), {
    message: "effectiveTo must be after effectiveFrom",
  });
/** One list price. */
export type PriceRate = z.infer<typeof PriceRate>;

/** A reviewed, immutable snapshot of list prices. */
export const PriceBook = z.object({
  id: OpaqueId,
  reviewedAt: Timestamp,
  rates: z.array(PriceRate).min(1),
});
/** A reviewed, immutable snapshot of list prices. */
export type PriceBook = z.infer<typeof PriceBook>;

/**
 * Validates a price book and freezes it deeply. Historical rates must never change after use;
 * a new price is a new book.
 */
export function definePriceBook(input: PriceBook): Readonly<PriceBook> {
  const book = PriceBook.parse(input);
  const rateIds = new Set(book.rates.map((rate) => rate.rateId));
  if (rateIds.size !== book.rates.length) throw new TypeError(`price book ${book.id} repeats a rateId`);
  return deepFreeze(book);
}

/** A rate's price as an exact rational number of nanodollars per unit. */
export function rateAsRational(rate: PriceRate): Rational {
  return { numerator: BigInt(rate.numeratorUsdNano), denominator: BigInt(rate.denominator) };
}

/**
 * The rates in `book` for one provider SKU that are in effect at `at`. Without `at`, every rate
 * for the SKU is returned, and the caller must treat more than one per unit as ambiguous.
 */
export function ratesFor(book: PriceBook, providerId: string, sku: string, at?: Date): PriceRate[] {
  return book.rates.filter(
    (rate) =>
      rate.providerId === providerId &&
      rate.sku === sku &&
      (at === undefined || isEffective(rate, at)),
  );
}

function isEffective(rate: PriceRate, at: Date): boolean {
  const time = at.getTime();
  return Date.parse(rate.effectiveFrom) <= time && (rate.effectiveTo === undefined || time < Date.parse(rate.effectiveTo));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
