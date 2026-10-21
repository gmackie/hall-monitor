import { CostReceipt, type UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { formatUsdNano, sumUsdNano } from "./usd-nano.ts";

/** Everything a receipt records except the totals, which are derived from the attempts. */
export type ReceiptInput = Omit<CostReceipt, "totalGrossUsdNano" | "hasUnknownCost">;

/**
 * Builds a validated, content-free receipt. The total sums priced attempts only; an unpriced or
 * unknown attempt sets `hasUnknownCost` so the total is read as a lower bound.
 */
export function buildReceipt(input: ReceiptInput): CostReceipt {
  const priced = input.attempts.flatMap((attempt) =>
    attempt.state !== "unknown" && attempt.grossUsdNano !== undefined ? [BigInt(attempt.grossUsdNano)] : [],
  );
  return CostReceipt.parse({
    ...input,
    totalGrossUsdNano: formatUsdNano(sumUsdNano(priced)),
    hasUnknownCost: input.attempts.some(hasUnknownCost),
  });
}

function hasUnknownCost(attempt: UsageAttempt): boolean {
  return attempt.state === "unknown" || attempt.grossUsdNano === undefined;
}
