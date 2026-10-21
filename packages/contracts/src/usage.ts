import { z } from "zod";
import { MachineCode, NonNegativeUsdNano, OpaqueId, Product, Timestamp } from "./primitives.ts";

const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Raw provider counters for one attempt. A missing counter means "not reported", which is never
 * the same as zero.
 */
export const UsageUnits = z.object({
  /** Total input tokens, including any cached ones. */
  inputTokens: Count.optional(),
  /** The subset of `inputTokens` served from a prompt cache. */
  cachedInputTokens: Count.optional(),
  outputTokens: Count.optional(),
  neurons: Count.optional(),
});
/** Raw provider counters for one attempt. */
export type UsageUnits = z.infer<typeof UsageUnits>;

/**
 * Where an attempt's usage came from: the provider's own report, a local estimate, or nowhere
 * (cost not known, to be reconciled later, and never assumed to be zero).
 */
export const UsageState = z.enum(["estimated", "provider_reported", "unknown"]);
/** Where an attempt's usage came from. */
export type UsageState = z.infer<typeof UsageState>;

/** One provider call, successful or not. Retries and escalations are separate attempts. */
export const UsageAttempt = z.object({
  attemptId: OpaqueId,
  attemptIndex: z.int().min(0).max(1000),
  providerId: OpaqueId,
  modelId: z.string().min(1).max(128),
  sku: z.string().min(1).max(128),
  priceBookId: OpaqueId,
  units: UsageUnits,
  /** Gross list-rate cost; absent when it cannot be priced. */
  grossUsdNano: NonNegativeUsdNano.optional(),
  state: UsageState,
  providerRequestId: OpaqueId.optional(),
  gatewayLogId: OpaqueId.optional(),
});
/** One provider call, successful or not. */
export type UsageAttempt = z.infer<typeof UsageAttempt>;

/**
 * The content-free cost record of one logical evaluation: identifiers, counters and amounts only.
 */
export const CostReceipt = z.object({
  receiptId: OpaqueId,
  tenantId: OpaqueId,
  product: Product,
  costCenterId: OpaqueId,
  logicalRequestId: OpaqueId,
  parentRequestId: OpaqueId.optional(),
  createdAt: Timestamp,
  /** What the spend was for, e.g. `moderation.input`. */
  purpose: MachineCode,
  attempts: z.array(UsageAttempt).max(16),
  /** Sum of the priced attempts. Unpriced attempts are flagged by `hasUnknownCost`, not added. */
  totalGrossUsdNano: NonNegativeUsdNano,
  /** True when any attempt's cost is unknown, so the total is a lower bound. */
  hasUnknownCost: z.boolean(),
});
/** The content-free cost record of one logical evaluation. */
export type CostReceipt = z.infer<typeof CostReceipt>;
