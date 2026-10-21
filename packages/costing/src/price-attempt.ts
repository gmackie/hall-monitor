import type { UsageAttempt, UsageUnits } from "@gmacko/hall-monitor-contracts";
import { type PriceBook, type PriceRate, type RateUnit, ratesFor } from "./price-book.ts";
import { ceilDiv, formatUsdNano } from "./usd-nano.ts";

/** Why an attempt could not be priced. Every issue leaves the attempt in state `unknown`. */
export type PricingIssue =
  | "usage_unknown"
  | "price_book_mismatch"
  | "no_rate"
  | "ambiguous_rate"
  | "missing_units"
  | "cached_exceeds_input";

/** An attempt with its gross cost filled in, or marked unknown with the reason. */
export interface PricedAttempt {
  readonly attempt: UsageAttempt;
  readonly issue: PricingIssue | null;
}

/** Options for {@link priceAttempt}. */
export interface PriceAttemptOptions {
  /** When the usage happened; selects rates by effective dates. Without it, rates must be unambiguous. */
  readonly at?: Date;
}

/**
 * Prices one attempt at the book's list rates.
 *
 * `inputTokens` includes cached tokens, so cached tokens are subtracted before charging the input
 * rate and charged at the cached rate instead; a SKU without a cached rate charges them as
 * ordinary input. An attempt whose required counters are missing is `unknown`, never free.
 *
 * The exact rational cost is rounded up once per attempt to whole nanodollars, so a receipt
 * never understates cost by more than the rounding of its own attempts.
 */
export function priceAttempt(book: PriceBook, attempt: UsageAttempt, options: PriceAttemptOptions = {}): PricedAttempt {
  if (attempt.state === "unknown") return unknown(attempt, "usage_unknown");
  if (attempt.priceBookId !== book.id) return unknown(attempt, "price_book_mismatch");

  const rates = ratesFor(book, attempt.providerId, attempt.sku, options.at);
  if (rates.length === 0) return unknown(attempt, "no_rate");
  const units = new Set(rates.map((rate) => rate.unit));
  if (units.size !== rates.length) return unknown(attempt, "ambiguous_rate");

  const quantities = billableQuantities(attempt.units, units);
  if (typeof quantities === "string") return unknown(attempt, quantities);

  const gross = exactCostCeil(rates, quantities);
  return { attempt: { ...attempt, grossUsdNano: formatUsdNano(gross) }, issue: null };
}

function billableQuantities(
  reported: UsageUnits,
  rated: ReadonlySet<RateUnit>,
): Map<RateUnit, bigint> | "missing_units" | "cached_exceeds_input" {
  const quantities = new Map<RateUnit, bigint>();
  const chargesTokens = rated.has("input_tokens") || rated.has("cached_input_tokens");
  if (chargesTokens) {
    if (reported.inputTokens === undefined) return "missing_units";
    // A provider that does not cache reports no cached counter; with input reported that is zero.
    const cached = BigInt(reported.cachedInputTokens ?? 0);
    const input = BigInt(reported.inputTokens);
    if (cached > input) return "cached_exceeds_input";
    if (rated.has("cached_input_tokens")) {
      quantities.set("cached_input_tokens", cached);
      quantities.set("input_tokens", input - cached);
    } else {
      quantities.set("input_tokens", input);
    }
  }
  if (rated.has("output_tokens")) {
    if (reported.outputTokens === undefined) return "missing_units";
    quantities.set("output_tokens", BigInt(reported.outputTokens));
  }
  if (rated.has("neurons")) {
    if (reported.neurons === undefined) return "missing_units";
    quantities.set("neurons", BigInt(reported.neurons));
  }
  if (rated.has("requests")) quantities.set("requests", 1n);
  return quantities;
}

/** Sums `quantity × numerator / denominator` over all rates exactly, then rounds up once. */
function exactCostCeil(rates: readonly PriceRate[], quantities: ReadonlyMap<RateUnit, bigint>): bigint {
  const denominator = rates.reduce((acc, rate) => lcm(acc, BigInt(rate.denominator)), 1n);
  let numerator = 0n;
  for (const rate of rates) {
    const quantity = quantities.get(rate.unit) ?? 0n;
    numerator += quantity * BigInt(rate.numeratorUsdNano) * (denominator / BigInt(rate.denominator));
  }
  return ceilDiv(numerator, denominator);
}

function unknown(attempt: UsageAttempt, issue: PricingIssue): PricedAttempt {
  const { grossUsdNano: _discarded, ...rest } = attempt;
  return { attempt: { ...rest, state: "unknown" }, issue };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}
