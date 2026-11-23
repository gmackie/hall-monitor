import { MODEL_REGISTRY } from "@gmacko/hall-monitor-costing";
import { OpaqueId, UsdNano } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import type { CalibrationReport } from "./calibration.ts";
import type { DecisionDiffReport, ShadowReport } from "./report.ts";

/**
 * The owner's thresholds for letting a model family enforce, per family. A preview family also
 * needs a recorded waiver (`previewWaiverRef`), mirrored in the Worker's `HM_MODEL_ENFORCE_WAIVERS`.
 */
export const ModelGatePolicy = z.strictObject({
  schemaVersion: z.literal("1.0"),
  families: z.partialRecord(z.enum(["clef", "clairic"]), z.strictObject({
    previewWaiverRef: OpaqueId.nullable(),
    /** Every held-out cohort and decision: Wilson 95% lower bound on precision at least this. */
    minPrecisionLower95: z.number().min(0).max(1),
    /** Every held-out cohort and decision: Wilson 95% upper bound on false-positive rate at most this. */
    maxFalsePositiveRateUpper95: z.number().min(0).max(1),
    /** Each metric needs at least this many adjudicated cases to count as evidence. */
    minAdjudicatedCases: z.int().min(1),
    /** Cost the family adds per 1,000 evaluations (candidate minus baseline), in nanodollars. */
    maxAddedUsdNanoPer1000: UsdNano,
    /** Candidate p95 classifier-stage latency, in milliseconds. */
    maxP95Ms: z.number().positive(),
  })),
});
/** The owner's model-gate thresholds. */
export type ModelGatePolicy = z.infer<typeof ModelGatePolicy>;

/** The evidence one gate evaluation reads. Missing evidence fails its gate; it is never assumed. */
export interface ModelGateEvidence {
  readonly family: "clef" | "clairic";
  readonly policy: ModelGatePolicy;
  /** Held-out calibration reports, one per model on the family's route. */
  readonly calibration?: readonly CalibrationReport[];
  /** A decision diff of the family switched on (`shadow-report diff --family <family>:enforce`). */
  readonly diff?: DecisionDiffReport;
  /** Shadow reports of the baseline and of the candidate with the family on. */
  readonly baselineReport?: ShadowReport;
  readonly candidateReport?: ShadowReport;
  /** Models a current governance enrollment lists for the tenant being considered. */
  readonly enrolledModels?: readonly string[];
}

/** One gate's outcome. `detail` names counts and codes only, never content. */
export interface GateResult {
  readonly id: "release-status" | "calibration" | "no-support-regression" | "cost" | "latency" | "governance";
  readonly pass: boolean;
  readonly detail: string;
}

/** The verdict: a family may enforce only when every gate passes, and then only after owner approval. */
export interface ModelGateVerdict {
  readonly schemaVersion: "1.0";
  readonly family: "clef" | "clairic";
  readonly verdict: "eligible-for-enforce" | "shadow-only";
  readonly activation: "not-approved";
  readonly gates: readonly GateResult[];
}

/**
 * Checks a model family against the owner's gates (see the plan's "Calibration, pricing, gates"):
 * release status or waiver, held-out calibration bounds for every model on the route, no `support`
 * regression on the synthetic corpus, added cost, p95 latency and a governance enrollment that
 * lists the models. The verdict is advisory and never activates anything: enforcing needs the
 * owner's approval, a routing change and, for preview models, the Worker waiver.
 */
export function evaluateModelGate(evidence: ModelGateEvidence): ModelGateVerdict {
  const thresholds = ModelGatePolicy.parse(evidence.policy).families[evidence.family];
  const models = MODEL_REGISTRY.filter((model) => model.family === evidence.family);
  const gates: GateResult[] = [];
  if (thresholds === undefined) {
    gates.push({ id: "release-status", pass: false, detail: "no gate policy for this family" });
    return verdictOf(evidence.family, gates);
  }

  const preview = models.filter((model) => model.status === "preview").map((model) => model.modelId);
  gates.push({
    id: "release-status",
    pass: preview.length === 0 || thresholds.previewWaiverRef !== null,
    detail: preview.length === 0 ? "all models GA" : thresholds.previewWaiverRef === null ? `preview without waiver: ${preview.join(", ")}` : `preview waived by ${thresholds.previewWaiverRef}`,
  });

  const reports = evidence.calibration ?? [];
  const missingModels = models.filter((model) => !reports.some((report) => report.modelId === model.modelId)).map((model) => model.modelId);
  const failing: string[] = [];
  for (const report of reports) {
    for (const metric of report.metrics) {
      const label = `${report.modelId}/${metric.decisionId}/${metric.cohort.profileId}:${metric.cohort.gradeBand ?? "any"}`;
      if (metric.adjudicated < thresholds.minAdjudicatedCases) failing.push(`${label} adjudicated ${metric.adjudicated}`);
      else if ((metric.precision.lower95 ?? 0) < thresholds.minPrecisionLower95) failing.push(`${label} precision.lower95 ${fmt(metric.precision.lower95)}`);
      else if ((metric.falsePositiveRate.upper95 ?? 1) > thresholds.maxFalsePositiveRateUpper95) failing.push(`${label} fpr.upper95 ${fmt(metric.falsePositiveRate.upper95)}`);
    }
  }
  const measured = reports.length > 0 && reports.every((report) => report.basis === "measured");
  gates.push({
    id: "calibration",
    pass: missingModels.length === 0 && failing.length === 0 && measured && reports.every((report) => report.metrics.length > 0),
    detail: missingModels.length > 0 ? `no held-out calibration for ${missingModels.join(", ")}`
      : !measured ? "calibration basis is simulated"
      : failing.length > 0 ? failing.slice(0, 10).join("; ")
      : `${reports.reduce((sum, report) => sum + report.metrics.length, 0)} metrics within bounds`,
  });

  const supportLost = evidence.diff === undefined ? undefined
    : Object.entries(evidence.diff.transitions).filter(([transition]) => transition.startsWith("support->")).reduce((sum, [, count]) => sum + count, 0);
  gates.push({
    id: "no-support-regression",
    pass: supportLost === 0,
    detail: supportLost === undefined ? "no decision diff supplied" : `${supportLost} support decisions changed`,
  });

  const base = evidence.baselineReport, candidate = evidence.candidateReport;
  const added = base === undefined || candidate === undefined ? undefined : BigInt(candidate.cost.grossUsdNanoPer1000) - BigInt(base.cost.grossUsdNanoPer1000);
  gates.push({
    id: "cost",
    pass: added !== undefined && candidate?.cost.basis === "measured" && added <= BigInt(thresholds.maxAddedUsdNanoPer1000),
    detail: added === undefined ? "no baseline and candidate shadow reports" : candidate?.cost.basis !== "measured" ? `cost basis is ${candidate?.cost.basis}` : `adds ${added} nanodollars per 1,000 (max ${thresholds.maxAddedUsdNanoPer1000})`,
  });

  const p95 = candidate?.latencyMs.classifier.p95Ms ?? null;
  gates.push({
    id: "latency",
    pass: p95 !== null && candidate?.cost.basis === "measured" && p95 <= thresholds.maxP95Ms,
    detail: p95 === null ? "no measured classifier latency" : `classifier p95 ${p95} ms (max ${thresholds.maxP95Ms})`,
  });

  const enrolled = evidence.enrolledModels;
  const unlisted = enrolled === undefined ? models.map((model) => model.modelId) : models.filter((model) => !enrolled.includes(model.modelId)).map((model) => model.modelId);
  gates.push({ id: "governance", pass: unlisted.length === 0, detail: unlisted.length === 0 ? "enrollment lists every model" : `not enrolled: ${unlisted.join(", ")}` });

  return verdictOf(evidence.family, gates);
}

function verdictOf(family: "clef" | "clairic", gates: readonly GateResult[]): ModelGateVerdict {
  return { schemaVersion: "1.0", family, verdict: gates.length > 0 && gates.every((gate) => gate.pass) ? "eligible-for-enforce" : "shadow-only", activation: "not-approved", gates };
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}
