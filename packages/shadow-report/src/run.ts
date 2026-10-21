import { type Decision, type EvaluationResult, SCHEMA_VERSION } from "@gmacko/hall-monitor-contracts";
import { evaluate, HallMonitorError } from "@gmacko/hall-monitor-core";
import { CLEF_MODEL, ceilDiv, formatUsdNano, PRICE_BOOK_CLOUDFLARE_2026_10_20, type PriceBook, sumUsdNano } from "@gmacko/hall-monitor-costing";
import { defaultBundle, type EvaluatorBundle } from "@gmacko/hall-monitor-evaluators";
import { type CaseResult, type FixtureCase, fixtureProfileId, fixtureRequest, scoreCorpus } from "@gmacko/hall-monitor-test-fixtures";
import type { CaseSet } from "./cases.ts";
import { type ClassifierChoice, classifierLabel, classifierPlugin } from "./classifier.ts";
import { type Agreement, type DecisionCounts, REPORT_VERSION, ShadowReport } from "./report.ts";
import { StageRecorder, summarizeLatency } from "./timing.ts";
import { BUILTIN_VARIANT, type PolicyVariant } from "./variant.ts";

/** How to evaluate a corpus. */
export interface RunOptions {
  /** Defaults to the built-in profiles. */
  readonly variant?: PolicyVariant;
  /**
   * Defaults to the fake classifier: without any classifier, every student profile fails closed
   * to `hold`, which measures the outage path rather than the policy.
   */
  readonly classifier?: ClassifierChoice;
  readonly priceBook?: PriceBook;
  readonly bundle?: EvaluatorBundle;
  /** Timestamps receipts and the report. */
  readonly clock?: () => Date;
  /** Copy each mismatched or changed case's synthetic text into the report. Off by default. */
  readonly includeText?: boolean;
}

/** One case's evaluation: its result or error code, and its measured stage latencies. */
export interface CaseEvaluation {
  readonly fixture: FixtureCase;
  readonly profileId: string;
  readonly result?: EvaluationResult;
  readonly errorCode?: string;
  readonly timings: { readonly total: number; readonly deterministic?: number; readonly classifier?: number };
}

/**
 * Evaluates every case through the real evaluation core, one at a time so stage latencies are
 * not skewed by concurrency. Each case is pinned to its profile's revision in the variant.
 * Decisions are enforced: a report measures what enforcement would do.
 */
export async function evaluateCases(set: CaseSet, options: RunOptions = {}): Promise<CaseEvaluation[]> {
  const variant = options.variant ?? BUILTIN_VARIANT;
  const priceBook = options.priceBook ?? PRICE_BOOK_CLOUDFLARE_2026_10_20;
  const clock = options.clock ?? (() => new Date());
  const recorder = new StageRecorder();
  const bundle = recorder.wrapBundle(options.bundle ?? defaultBundle);
  const plugin = classifierPlugin(options.classifier ?? { kind: "fake" }, priceBook);
  const classifier = plugin === undefined ? undefined : recorder.wrap("classifier", plugin);

  const evaluations: CaseEvaluation[] = [];
  for (const [index, fixture] of set.cases.entries()) {
    const profileId = fixtureProfileId(fixture);
    const base = fixtureRequest(fixture);
    const revision = Object.hasOwn(variant.profiles, profileId) ? variant.profiles[profileId]!.revision : base.policy.revision;
    const request = { ...base, schemaVersion: SCHEMA_VERSION, policy: { profileId, revision } };
    recorder.reset();
    const started = performance.now();
    let outcome: { result: EvaluationResult } | { errorCode: string };
    try {
      outcome = {
        result: await evaluate(request, {
          policies: (id, pinned) => {
            const profile = Object.hasOwn(variant.profiles, id) ? variant.profiles[id] : undefined;
            return profile?.revision === pinned ? profile : undefined;
          },
          bundle,
          ...(classifier === undefined ? {} : { classifier }),
          priceBook,
          clock,
          ids: { evaluationId: () => `eval_shadow_${index}`, receiptId: () => `rcpt_shadow_${index}` },
          ...(variant.resolve === undefined ? {} : { resolve: variant.resolve }),
        }),
      };
    } catch (error) {
      if (!(error instanceof HallMonitorError)) throw error;
      outcome = { errorCode: error.body.code };
    }
    const total = performance.now() - started;
    const deterministic = recorder.duration("deterministic");
    const classified = recorder.duration("classifier");
    evaluations.push({
      fixture,
      profileId,
      ...outcome,
      timings: { total, ...(deterministic === undefined ? {} : { deterministic }), ...(classified === undefined ? {} : { classifier: classified }) },
    });
  }
  return evaluations;
}

/** Evaluates a corpus and builds its shadow report. */
export async function runShadowReport(set: CaseSet, options: RunOptions = {}): Promise<ShadowReport> {
  return buildShadowReport(set, await evaluateCases(set, options), options);
}

/** Builds a shadow report from evaluated cases. */
export function buildShadowReport(set: CaseSet, evaluations: readonly CaseEvaluation[], options: RunOptions = {}): ShadowReport {
  const variant = options.variant ?? BUILTIN_VARIANT;
  const classifier = classifierLabel(options.classifier ?? { kind: "fake" });
  const priceBook = options.priceBook ?? PRICE_BOOK_CLOUDFLARE_2026_10_20;
  const decided = evaluations.flatMap((evaluation) => (evaluation.result === undefined ? [] : [{ ...evaluation, result: evaluation.result }]));
  const profiles = [...new Set(evaluations.map((evaluation) => evaluation.profileId))].sort();

  const distribution = {
    overall: countDecisions(decided.map((entry) => entry.result.decision)),
    byProfile: groupCounts(decided, (entry) => entry.profileId),
    byGradeBand: groupCounts(decided, (entry) => entry.fixture.gradeBand),
    byCategory: groupCounts(decided, (entry) => entry.fixture.category),
  };

  const confusion: Partial<Record<Decision, DecisionCounts>> = {};
  for (const entry of decided) {
    const row = (confusion[entry.fixture.expectedDecision] ??= {});
    row[entry.result.decision] = (row[entry.result.decision] ?? 0) + 1;
  }
  const byProfile: Record<string, Agreement> = {};
  for (const profileId of profiles) byProfile[profileId] = agreement(decided.filter((entry) => entry.profileId === profileId));

  const caseResults: CaseResult[] = decided.map((entry) => ({ fixture: entry.fixture, decision: entry.result.decision, categories: findingCategories(entry.result) }));
  const score = scoreCorpus(caseResults);
  const texts = new Map(evaluations.map((evaluation) => [evaluation.fixture.id, evaluation.fixture.text]));

  const receipts = decided.flatMap((entry) => (entry.result.receipt === null ? [] : [entry.result.receipt]));
  const total = sumUsdNano(receipts.map((receipt) => BigInt(receipt.totalGrossUsdNano)));
  const per1000 = decided.length === 0 ? 0n : ceilDiv(total * 1000n, BigInt(decided.length));
  const orchestration = evaluations.map((evaluation) => Math.max(0, evaluation.timings.total - (evaluation.timings.deterministic ?? 0) - (evaluation.timings.classifier ?? 0)));
  const revisions = Object.fromEntries(profiles.flatMap((id) => (Object.hasOwn(variant.profiles, id) ? [[id, variant.profiles[id]!.revision]] : [])));

  return ShadowReport.parse({
    reportVersion: REPORT_VERSION,
    kind: "shadow-run",
    generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    corpus: { source: set.source, cases: set.cases.length },
    configuration: {
      policy: variant.label,
      profiles,
      policyRevisions: revisions,
      resolverVersion: variant.resolverVersion,
      evaluatorBundleRevision: decided[0]?.result.evaluatorBundleRevision ?? null,
      classifier,
      priceBookId: priceBook.id,
    },
    distribution,
    agreement: { overall: agreement(decided), byProfile, confusion },
    quality: {
      byCategory: score.byCategory,
      byGradeBand: score.byGradeBand,
      mismatches: score.mismatches.map((mismatch) => (options.includeText === true ? { ...mismatch, text: texts.get(mismatch.id) } : mismatch)),
    },
    latencyMs: {
      total: summarizeLatency(evaluations.map((evaluation) => evaluation.timings.total)),
      deterministic: summarizeLatency(evaluations.flatMap((evaluation) => evaluation.timings.deterministic ?? [])),
      classifier: summarizeLatency(evaluations.flatMap((evaluation) => evaluation.timings.classifier ?? [])),
      orchestration: summarizeLatency(orchestration),
    },
    cost: {
      basis: classifier === "none" ? "none" : classifier === "fake" ? "simulated" : "measured",
      evaluations: decided.length,
      billedEvaluations: receipts.length,
      attempts: receipts.reduce((sum, receipt) => sum + receipt.attempts.length, 0),
      escalations: receipts.reduce((sum, receipt) => sum + receipt.attempts.filter((attempt) => attempt.modelId === CLEF_MODEL).length, 0),
      unknownCostEvaluations: receipts.filter((receipt) => receipt.hasUnknownCost).length,
      totalGrossUsdNano: formatUsdNano(total),
      grossUsdNanoPer1000: formatUsdNano(per1000),
      grossUsdPer1000: formatUsdMicros(per1000),
    },
    errors: evaluations.flatMap((evaluation) => (evaluation.errorCode === undefined ? [] : [{ id: evaluation.fixture.id, code: evaluation.errorCode }])),
  });
}

/**
 * Formats nanodollars as dollars rounded up to the millionth, e.g. `"$0.006171"`. Per-1,000
 * moderation costs are fractions of a cent, so whole cents would hide them; this is for display
 * only and the report keeps the exact nanodollars beside it.
 */
export function formatUsdMicros(amount: bigint): string {
  const micros = ceilDiv(amount, 1000n);
  return `$${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Categories of a result's non-informational findings, as `scoreCorpus` expects. */
export function findingCategories(result: EvaluationResult): CaseResult["categories"] {
  return [...new Set(result.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.category))];
}

/** Agreement of decided cases with their expected decisions. */
export function agreement(entries: readonly { fixture: FixtureCase; result: EvaluationResult }[]): Agreement {
  const agreed = entries.filter((entry) => entry.result.decision === entry.fixture.expectedDecision).length;
  return { agreed, total: entries.length, rate: entries.length === 0 ? null : agreed / entries.length };
}

function countDecisions(decisions: readonly Decision[]): DecisionCounts {
  const counts: DecisionCounts = {};
  for (const decision of decisions) counts[decision] = (counts[decision] ?? 0) + 1;
  return counts;
}

function groupCounts<T extends { result: EvaluationResult }>(entries: readonly T[], key: (entry: T) => string): Record<string, DecisionCounts> {
  const groups: Record<string, Decision[]> = {};
  for (const entry of entries) (groups[key(entry)] ??= []).push(entry.result.decision);
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([name, decisions]) => [name, countDecisions(decisions)]));
}
