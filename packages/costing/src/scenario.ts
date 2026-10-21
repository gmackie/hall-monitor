import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "./cloudflare-2026-10-20.ts";
import { type PriceBook, rateAsRational, ratesFor } from "./price-book.ts";
import { ceilDiv, NANO_PER_USD, type Rational } from "./usd-nano.ts";

/**
 * Planning inputs for the monthly Hall Monitor model cost (COST-08, 03-PRICING §3). Every default
 * is an analyst assumption to be replaced by pilot measurements.
 */
export interface HallMonitorScenarioInput {
  readonly activeTeachers: number;
  readonly aiStudents: number;
  /** Moderated messages per active teacher per month. */
  readonly teacherCalls?: number;
  /** Moderated messages per AI-enabled student per month. */
  readonly studentCalls?: number;
  /** Billed input tokens per input check. */
  readonly inputCheckTokens?: number;
  /** Billed input tokens per output check; zero models input-only moderation. */
  readonly outputCheckTokens?: number;
  /** Share of messages escalated to Clef, as an exact fraction. */
  readonly escalationShare?: { readonly num: number; readonly den: number };
  /** Billed input tokens per escalation. */
  readonly escalationTokens?: number;
  /** Price book to read the Clef-flash and Clef input rates from. */
  readonly priceBook?: PriceBook;
}

/** Monthly gross list-rate cost of a scenario, before free allowances and credits. */
export interface HallMonitorScenarioCost {
  readonly messages: bigint;
  readonly flashUsdNano: bigint;
  readonly escalationUsdNano: bigint;
  readonly totalUsdNano: bigint;
}

/**
 * Computes a scenario's moderation cost exactly:
 *
 *     messages   = teachers × teacherCalls + students × studentCalls
 *     flash      = messages × (inputCheckTokens + outputCheckTokens) × flashRate
 *     escalation = messages × escalationShare × escalationTokens × clefRate
 *
 * Each column is computed as an exact rational and rounded up to whole nanodollars, and the total
 * is the sum of the rounded columns.
 */
export function hallMonitorScenario(input: HallMonitorScenarioInput): HallMonitorScenarioCost {
  const book = input.priceBook ?? PRICE_BOOK_CLOUDFLARE_2026_10_20;
  const share = input.escalationShare ?? { num: 1, den: 10 };
  if (share.den <= 0 || share.num < 0 || share.num > share.den) throw new RangeError("escalationShare must be in [0, 1]");

  const messages =
    count(input.activeTeachers, "activeTeachers") * count(input.teacherCalls ?? 320, "teacherCalls") +
    count(input.aiStudents, "aiStudents") * count(input.studentCalls ?? 78, "studentCalls");
  const checkTokens =
    count(input.inputCheckTokens ?? 1000, "inputCheckTokens") + count(input.outputCheckTokens ?? 1000, "outputCheckTokens");
  const escalationTokens = count(input.escalationTokens ?? 1500, "escalationTokens");

  const flashRate = inputTokenRate(book, CLEF_FLASH_MODEL);
  const clefRate = inputTokenRate(book, CLEF_MODEL);
  const flashUsdNano = ceilDiv(messages * checkTokens * flashRate.numerator, flashRate.denominator);
  const escalationUsdNano = ceilDiv(
    messages * BigInt(share.num) * escalationTokens * clefRate.numerator,
    BigInt(share.den) * clefRate.denominator,
  );
  return { messages, flashUsdNano, escalationUsdNano, totalUsdNano: flashUsdNano + escalationUsdNano };
}

/** Inputs for the protected organizational safety reserve. */
export interface SafetyReserveInput {
  readonly activeTeachers: number;
  readonly aiStudents: number;
  /** Floor of the reserve; defaults to $5. */
  readonly minimumUsdNano?: bigint;
  /** Reserve per AI-enabled person; defaults to $0.10. */
  readonly perUserUsdNano?: bigint;
}

/**
 * The monthly Hall Monitor safety reserve, `max($5, $0.10 × (teachers + students))`
 * (03-PRICING §7). It funds mandatory moderation and is never drawn from a child's allowance.
 */
export function hallMonitorSafetyReserveUsdNano(input: SafetyReserveInput): bigint {
  const minimum = input.minimumUsdNano ?? 5n * NANO_PER_USD;
  const perUser = input.perUserUsdNano ?? NANO_PER_USD / 10n;
  const scaled = perUser * (count(input.activeTeachers, "activeTeachers") + count(input.aiStudents, "aiStudents"));
  return scaled > minimum ? scaled : minimum;
}

function inputTokenRate(book: PriceBook, sku: string): Rational {
  const rates = ratesFor(book, CLOUDFLARE_WORKERS_AI, sku).filter((rate) => rate.unit === "input_tokens");
  const [rate] = rates;
  if (rate === undefined || rates.length > 1) throw new RangeError(`price book ${book.id} needs exactly one input rate for ${sku}`);
  return rateAsRational(rate);
}

function count(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return BigInt(value);
}
