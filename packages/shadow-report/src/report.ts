import { Decision, GradeBand, MachineCode, OpaqueId, Timestamp, UsdNano } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/**
 * Report schemas. Reports are content-free by construction: identifiers, codes, counts, rates,
 * latencies and money. The only text field is the optional `text` of a mismatch or change, which
 * is filled in only on request (`--include-text`) and only from synthetic cases.
 */

const Count = z.int().min(0);
const Rate = z.number().min(0).max(1).nullable();

/** The format version of both reports. */
export const REPORT_VERSION = "1";

/** Decision counts. */
export const DecisionCounts = z.partialRecord(Decision, Count);
/** Decision counts. */
export type DecisionCounts = z.infer<typeof DecisionCounts>;

/** Agreement of actual decisions with the expected ones. */
export const Agreement = z.object({ agreed: Count, total: Count, rate: Rate });
/** Agreement of actual decisions with the expected ones. */
export type Agreement = z.infer<typeof Agreement>;

/** Binary detection counts and rates, as computed by `scoreCorpus`. */
export const Metric = z.object({
  truePositives: Count,
  falsePositives: Count,
  falseNegatives: Count,
  precision: Rate,
  recall: Rate,
});

/** A stage's measured latency. */
export const LatencySummary = z.object({
  samples: Count,
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable(),
  maxMs: z.number().min(0).nullable(),
});

/** Which classifier produced the run, and so how to read its costs. */
export const ClassifierLabel = z.enum(["none", "fake", "gateway"]);

const CorpusInfo = z.object({
  /** `builtin`, or the case file's name. Never the file's contents. */
  source: z.string().min(1).max(256),
  cases: Count,
});

/** A shadow run over a synthetic corpus. */
export const ShadowReport = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  kind: z.literal("shadow-run"),
  generatedAt: Timestamp,
  corpus: CorpusInfo,
  configuration: z.object({
    policy: z.string().min(1).max(128),
    profiles: z.array(OpaqueId),
    policyRevisions: z.record(OpaqueId, OpaqueId),
    resolverVersion: OpaqueId,
    evaluatorBundleRevision: OpaqueId.nullable(),
    classifier: ClassifierLabel,
    priceBookId: OpaqueId,
  }),
  distribution: z.object({
    overall: DecisionCounts,
    byProfile: z.record(OpaqueId, DecisionCounts),
    byGradeBand: z.partialRecord(GradeBand, DecisionCounts),
    byCategory: z.record(z.string(), DecisionCounts),
  }),
  agreement: z.object({
    overall: Agreement,
    byProfile: z.record(OpaqueId, Agreement),
    /** Expected decision → actual decision → count. */
    confusion: z.partialRecord(Decision, DecisionCounts),
  }),
  quality: z.object({
    byCategory: z.record(z.string(), Metric),
    byGradeBand: z.partialRecord(GradeBand, Metric.extend({ cases: Count, decisionAccuracy: Rate })),
    mismatches: z.array(
      z.object({ id: OpaqueId, expected: Decision, actual: Decision, requiresClassifier: z.boolean(), text: z.string().optional() }),
    ),
  }),
  latencyMs: z.object({
    total: LatencySummary,
    deterministic: LatencySummary,
    classifier: LatencySummary,
    /** Total minus the measured stages: validation, policy lookup, resolution and receipt. */
    orchestration: LatencySummary,
  }),
  cost: z.object({
    /** `simulated` for the fake classifier, `measured` for a real one, `none` without one. */
    basis: z.enum(["none", "simulated", "measured"]),
    evaluations: Count,
    billedEvaluations: Count,
    attempts: Count,
    escalations: Count,
    unknownCostEvaluations: Count,
    totalGrossUsdNano: UsdNano,
    /** Gross cost per 1,000 evaluations, rounded up to the nanodollar. A lower bound when any cost is unknown. */
    grossUsdNanoPer1000: UsdNano,
    grossUsdPer1000: z.string(),
  }),
  errors: z.array(z.object({ id: OpaqueId, code: z.string().max(64) })),
});
/** A shadow run over a synthetic corpus. */
export type ShadowReport = z.infer<typeof ShadowReport>;

const VariantSummary = z.object({
  label: z.string().min(1).max(128),
  policyRevisions: z.record(OpaqueId, OpaqueId),
  resolverVersion: OpaqueId,
  clampedFields: z.array(z.string().max(200)),
});

/** One case whose decision differs between the baseline and the candidate. */
export const DecisionChange = z.object({
  id: OpaqueId,
  profileId: OpaqueId,
  gradeBand: GradeBand,
  category: z.string(),
  expected: Decision,
  from: Decision,
  to: Decision,
  reasonCodesAdded: z.array(MachineCode),
  reasonCodesRemoved: z.array(MachineCode),
  text: z.string().optional(),
});
/** One case whose decision differs between the baseline and the candidate. */
export type DecisionChange = z.infer<typeof DecisionChange>;

/** The decision difference between two policy variants over the same frozen corpus. */
export const DecisionDiffReport = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  kind: z.literal("decision-diff"),
  generatedAt: Timestamp,
  corpus: CorpusInfo,
  classifier: ClassifierLabel,
  baseline: VariantSummary,
  candidate: VariantSummary,
  changed: Count,
  /** Cases with the same decision but different reason codes. */
  reasonCodesOnlyChanged: Count,
  /** `from->to` → count. */
  transitions: z.record(z.string(), Count),
  /**
   * Changed cases by reason code: every changed case carrying the code under either variant, and
   * the subsets where the code appeared (candidate only) or disappeared (baseline only).
   */
  byReasonCode: z.record(MachineCode, z.object({ cases: z.array(OpaqueId), added: z.array(OpaqueId), removed: z.array(OpaqueId) })),
  /** Agreement with the expected decisions under each variant. */
  agreement: z.object({ baseline: Agreement, candidate: Agreement }),
  changes: z.array(DecisionChange),
  errors: z.array(z.object({ id: OpaqueId, variant: z.enum(["baseline", "candidate"]), code: z.string().max(64) })),
});
/** The decision difference between two policy variants over the same frozen corpus. */
export type DecisionDiffReport = z.infer<typeof DecisionDiffReport>;
