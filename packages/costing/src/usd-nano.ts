import { UsdNano } from "@gmacko/hall-monitor-contracts";

/** Nanodollars in one US dollar. */
export const NANO_PER_USD = 1_000_000_000n;

/** Nanodollars in one US cent. */
export const NANO_PER_CENT = 10_000_000n;

/** A non-negative rational number `numerator / denominator`, both integers. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Parses a wire `UsdNano` string into a bigint; throws on anything but a decimal integer. */
export function parseUsdNano(value: string): bigint {
  if (!UsdNano.safeParse(value).success) throw new TypeError("not a UsdNano decimal integer string");
  return BigInt(value);
}

/** Formats a bigint amount of nanodollars as its wire `UsdNano` string. */
export function formatUsdNano(amount: bigint): UsdNano {
  return amount.toString();
}

/** Adds nanodollar amounts. */
export function addUsdNano(left: bigint, right: bigint): bigint {
  return left + right;
}

/** Sums nanodollar amounts; the empty sum is zero. */
export function sumUsdNano(amounts: Iterable<bigint>): bigint {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}

/**
 * Converts a decimal dollar string such as `"0.038"` to exact nanodollars. Throws when the value
 * has more than nine decimal places, since that could not be represented without rounding.
 */
export function usdToNano(usd: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,9}))?$/.exec(usd);
  if (match === null) throw new TypeError("not an exact decimal dollar amount with at most 9 places");
  const [, sign = "", whole = "0", fraction = ""] = match;
  const magnitude = BigInt(whole) * NANO_PER_USD + BigInt(fraction.padEnd(9, "0"));
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * Multiplies `quantity` by a rational rate, rounding a fractional result up to the next whole
 * nanodollar. Rounding up means a computed cost is never below the exact cost.
 */
export function mulRationalCeil(quantity: bigint, rate: Rational): bigint {
  assertNonNegativeRational(rate);
  if (quantity < 0n) throw new RangeError("quantity must be non-negative");
  return ceilDiv(quantity * rate.numerator, rate.denominator);
}

/** Integer division of non-negative operands, rounding up. */
export function ceilDiv(dividend: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError("divisor must be positive");
  if (dividend < 0n) throw new RangeError("dividend must be non-negative");
  return (dividend + divisor - 1n) / divisor;
}

/**
 * Rounds a non-negative nanodollar amount up to whole cents, for display and invoices only.
 * Ledgers keep nanodollars; rounding happens once, at presentation.
 */
export function ceilToCents(amount: bigint): bigint {
  return ceilDiv(amount, NANO_PER_CENT);
}

/** Formats a non-negative nanodollar amount as dollars rounded up to the cent, e.g. `"$7.20"`. */
export function formatUsdCents(amount: bigint): string {
  const cents = ceilToCents(amount);
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function assertNonNegativeRational(rate: Rational): void {
  if (rate.denominator <= 0n) throw new RangeError("rate denominator must be positive");
  if (rate.numerator < 0n) throw new RangeError("rate numerator must be non-negative");
}
