import { CORPUS, scoreCorpus } from "@gmacko/hall-monitor-test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BUILTIN_CASES,
  evaluateCases,
  findingCategories,
  formatUsdMicros,
  percentile,
  renderShadowMarkdown,
  runShadowReport,
  selectCases,
  ShadowReport,
  summarizeLatency,
} from "../src/index.ts";

const clock = () => new Date("2026-10-21T00:00:00.000Z");

/** Distinctive corpus texts, which must never appear in a report unless asked for. */
const TEXTS = CORPUS.map((fixture) => fixture.text).filter((text) => text.length >= 20);

describe("shadow report over the frozen corpus", () => {
  let report: ShadowReport;
  beforeAll(async () => {
    report = await runShadowReport(BUILTIN_CASES, { clock });
  });

  it("is a valid, versioned report over every case", () => {
    expect(ShadowReport.parse(report)).toEqual(report);
    expect(report).toMatchObject({ reportVersion: "1", kind: "shadow-run", generatedAt: "2026-10-21T00:00:00.000Z", corpus: { source: "builtin", cases: CORPUS.length } });
    expect(report.configuration).toMatchObject({ policy: "builtin", classifier: "fake", resolverVersion: "resolver-1.0.0", evaluatorBundleRevision: "base-1.0.0:clef-1.0.0" });
    expect(report.configuration.profiles).toEqual(["educator", "published-content", "student-6-8", "student-9-12"]);
    expect(report.errors).toEqual([]);
  });

  it("counts every decision once in each distribution", () => {
    const total = (counts: Record<string, number | undefined>) => Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
    expect(total(report.distribution.overall)).toBe(CORPUS.length);
    for (const grouping of [report.distribution.byProfile, report.distribution.byGradeBand, report.distribution.byCategory]) {
      expect(Object.values(grouping).reduce((sum, counts) => sum + total(counts ?? {}), 0)).toBe(CORPUS.length);
    }
  });

  it("reports agreement and quality consistent with scoreCorpus", async () => {
    const evaluations = await evaluateCases(BUILTIN_CASES, { clock });
    const score = scoreCorpus(evaluations.map((e) => ({ fixture: e.fixture, decision: e.result!.decision, categories: findingCategories(e.result!) })));
    expect(report.quality.byCategory).toEqual(score.byCategory);
    expect(report.quality.mismatches).toEqual(score.mismatches);
    expect(report.agreement.overall.total - report.agreement.overall.agreed).toBe(score.mismatches.length);
    // The deterministic bundle decides every case it is expected to decide.
    expect(report.quality.mismatches.filter((mismatch) => !mismatch.requiresClassifier)).toEqual([]);
    const confusion = Object.values(report.agreement.confusion).reduce((sum, row) => sum + Object.values(row ?? {}).reduce<number>((a, n) => a + (n ?? 0), 0), 0);
    expect(confusion).toBe(CORPUS.length);
  });

  it("measures latency per stage", () => {
    const { total, deterministic, classifier, orchestration } = report.latencyMs;
    expect(total.samples).toBe(CORPUS.length);
    expect(deterministic.samples).toBe(CORPUS.length);
    expect(orchestration.samples).toBe(CORPUS.length);
    expect(classifier.samples).toBe(report.cost.billedEvaluations);
    for (const stage of [total, deterministic, classifier, orchestration]) {
      expect(stage.p50Ms).not.toBeNull();
      expect(stage.p50Ms!).toBeLessThanOrEqual(stage.p95Ms!);
      expect(stage.p95Ms!).toBeLessThanOrEqual(stage.maxMs!);
    }
  });

  it("estimates gross cost per 1,000 evaluations from the receipts", () => {
    const { cost } = report;
    expect(cost).toMatchObject({ basis: "simulated", evaluations: CORPUS.length, escalations: 0, unknownCostEvaluations: 0 });
    expect(cost.billedEvaluations).toBeGreaterThan(0);
    expect(cost.attempts).toBe(cost.billedEvaluations);
    const total = BigInt(cost.totalGrossUsdNano);
    expect(total).toBeGreaterThan(0n);
    const n = BigInt(CORPUS.length);
    expect(BigInt(cost.grossUsdNanoPer1000)).toBe((total * 1000n + n - 1n) / n);
    expect(cost.grossUsdPer1000).toBe(formatUsdMicros(BigInt(cost.grossUsdNanoPer1000)));
  });

  it("is content-free unless text is requested", async () => {
    const json = JSON.stringify(report) + renderShadowMarkdown(report);
    for (const text of TEXTS) expect(json).not.toContain(text);
    const withText = await runShadowReport(BUILTIN_CASES, { clock, includeText: true });
    const mismatch = withText.quality.mismatches[0]!;
    expect(mismatch.text).toBe(CORPUS.find((fixture) => fixture.id === mismatch.id)!.text);
  });

  it("renders Markdown with every section", () => {
    const markdown = renderShadowMarkdown(report);
    for (const heading of ["Decision distribution", "Agreement with expected decisions", "Detection quality", "Latency (measured, ms)", "Estimated gross cost"]) {
      expect(markdown).toContain(`## ${heading}`);
    }
    expect(markdown).toContain(`${report.cost.grossUsdPer1000} per 1,000 evaluations`);
  });
});

describe("classifier choices", () => {
  it("without a classifier, student profiles fail closed and nothing is billed", async () => {
    const report = await runShadowReport(selectCases(BUILTIN_CASES, ["student-9-12"]), { classifier: { kind: "none" }, clock });
    expect(report.configuration.classifier).toBe("none");
    expect(report.cost).toMatchObject({ basis: "none", billedEvaluations: 0, totalGrossUsdNano: "0", grossUsdNanoPer1000: "0" });
    expect(report.distribution.overall.allow ?? 0).toBe(0);
    expect(report.latencyMs.classifier.samples).toBe(0);
    expect(report.latencyMs.classifier.p50Ms).toBeNull();
  });

  it("measures a real transport's usage as reported, including escalations", async () => {
    const { CLEF_QUESTIONS } = await import("@gmacko/hall-monitor-clef");
    const answers = (score: number) => Object.fromEntries(CLEF_QUESTIONS.map((question) => [question.id, { type: "noul", noul: score }]));
    let calls = 0;
    const transport = {
      async run() {
        calls++;
        return { output: { answers: answers(calls % 2 === 1 ? 0.5 : 0.02) }, usage: { inputTokens: 1000 } };
      },
    };
    const set = selectCases(BUILTIN_CASES, ["educator"]);
    const report = await runShadowReport(set, { classifier: { kind: "transport", label: "gateway", transport }, clock });
    expect(report.cost.basis).toBe("measured");
    expect(report.cost.escalations).toBe(report.cost.billedEvaluations);
    expect(report.cost.attempts).toBe(2 * report.cost.billedEvaluations);
  });
});

describe("percentiles", () => {
  it("use the nearest-rank method", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(summarizeLatency([1.23456, 2])).toEqual({ samples: 2, p50Ms: 1.235, p95Ms: 2, maxMs: 2 });
  });

  it("format per-1,000 costs to the millionth of a dollar, rounding up", () => {
    expect(formatUsdMicros(6_170_250n)).toBe("$0.006171");
    expect(formatUsdMicros(0n)).toBe("$0.000000");
    expect(formatUsdMicros(12_000_000_000n)).toBe("$12.000000");
  });
});
