/**
 * Reference planning math only, not a bill, staffing SLA, or individualized risk score.
 * All currency uses integer nanodollars. No assumptions about live incidence rates.
 */
export interface CapacityScenario {
  readonly monthlyMessages: number;
  /** 0..1 routed to a particular model, not the model's sensitivity. */
  readonly routedFraction: number;
  readonly inputTokensPerRoutedMessage: number;
  /** Nanodollars per million input tokens, e.g. 38000000n for $0.038. */
  readonly modelPriceNanoPerMillion: bigint;
  /** Fraction of messages sent to qualified human review. */
  readonly humanReviewFraction: number;
  readonly averageReviewSeconds: number;
  readonly humanHourlyPriceNano: bigint;
}

export interface CapacityEstimate {
  readonly routedMessages: number;
  readonly inputTokens: bigint;
  readonly modelCostUsdNano: bigint;
  readonly humanReviews: number;
  readonly humanSeconds: bigint;
  readonly humanCostUsdNano: bigint;
}

const MILLION = 1000000n;
function ceilDivide(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }

export function estimateCapacity(input: CapacityScenario): CapacityEstimate {
  const count = input.monthlyMessages;
  if (!Number.isSafeInteger(count) || count < 0 ||
      !Number.isSafeInteger(input.inputTokensPerRoutedMessage) ||
      input.inputTokensPerRoutedMessage < 0 ||
      !Number.isSafeInteger(input.averageReviewSeconds) ||
      input.averageReviewSeconds < 0 ||
      !Number.isFinite(input.routedFraction) || input.routedFraction < 0 || input.routedFraction > 1 ||
      !Number.isFinite(input.humanReviewFraction) ||
      input.humanReviewFraction < 0 || input.humanReviewFraction > 1 ||
      input.modelPriceNanoPerMillion < 0n || input.humanHourlyPriceNano < 0n) {
    throw new RangeError("invalid capacity scenario");
  }
  const routedMessages = Math.round(count * input.routedFraction);
  const humanReviews = Math.round(count * input.humanReviewFraction);
  const inputTokens = BigInt(routedMessages) * BigInt(input.inputTokensPerRoutedMessage);
  const humanSeconds = BigInt(humanReviews) * BigInt(input.averageReviewSeconds);
  return {
    routedMessages, inputTokens,
    modelCostUsdNano: ceilDivide(inputTokens * input.modelPriceNanoPerMillion, MILLION),
    humanReviews, humanSeconds,
    humanCostUsdNano: ceilDivide(humanSeconds * input.humanHourlyPriceNano, 3600n),
  };
}

/** Theoretical positive predictive value given fixed sensitivity/specificity/base rate.
 * This is a synthetic diagnostic illustration, not a measured bullying prevalence.
 */
export function positivePredictiveValue(
  prevalence: number, sensitivity: number, specificity: number,
): number | null {
  if (![prevalence, sensitivity, specificity].every((n) =>
    Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new RangeError("probabilities must be between 0 and 1");
  }
  const tp = sensitivity * prevalence;
  const fp = (1 - specificity) * (1 - prevalence);
  return tp + fp === 0 ? null : tp / (tp + fp);
}
