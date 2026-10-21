import type { Decision, FindingCategory, GradeBand } from "@gmacko/hall-monitor-contracts";
import type { FixtureCase } from "./types.ts";

/** The outcome of evaluating one case. */
export interface CaseResult {
  readonly fixture: FixtureCase;
  readonly decision: Decision;
  /** Categories of the non-informational findings that were raised. */
  readonly categories: readonly FindingCategory[];
}

/** Binary-classification counts with derived rates; a rate is null when its denominator is 0. */
export interface Metric {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

/** Per-band detection metrics plus how often the exact decision was right. */
export interface BandMetric extends Metric {
  readonly cases: number;
  readonly decisionAccuracy: number | null;
}

/** A case whose decision differed from the expected one. */
export interface Mismatch {
  readonly id: string;
  readonly expected: Decision;
  readonly actual: Decision;
  readonly requiresClassifier: boolean;
}

/** Corpus quality report: never a single headline accuracy. */
export interface CorpusScore {
  /** Per finding category: a positive is a case about that category that should not be allowed. */
  readonly byCategory: Readonly<Partial<Record<FindingCategory, Metric>>>;
  /** Per grade band: a positive is any case that should not be allowed. */
  readonly byGradeBand: Readonly<Partial<Record<GradeBand, BandMetric>>>;
  readonly mismatches: readonly Mismatch[];
}

/** Scores evaluated cases by category and by grade band. */
export function scoreCorpus(results: readonly CaseResult[]): CorpusScore {
  const categories = new Set<FindingCategory>();
  for (const result of results) {
    if (result.fixture.category !== "none") categories.add(result.fixture.category);
    for (const category of result.categories) categories.add(category);
  }

  const byCategory: Partial<Record<FindingCategory, Metric>> = {};
  for (const category of [...categories].sort()) {
    byCategory[category] = metric(
      results,
      (result) => result.fixture.category === category && result.fixture.expectedDecision !== "allow",
      (result) => result.categories.includes(category),
    );
  }

  const byGradeBand: Partial<Record<GradeBand, BandMetric>> = {};
  for (const band of [...new Set(results.map((result) => result.fixture.gradeBand))].sort()) {
    const inBand = results.filter((result) => result.fixture.gradeBand === band);
    const correct = inBand.filter((result) => result.decision === result.fixture.expectedDecision).length;
    byGradeBand[band] = {
      ...metric(
        inBand,
        (result) => result.fixture.expectedDecision !== "allow",
        (result) => result.decision !== "allow",
      ),
      cases: inBand.length,
      decisionAccuracy: rate(correct, inBand.length),
    };
  }

  const mismatches = results
    .filter((result) => result.decision !== result.fixture.expectedDecision)
    .map((result) => ({
      id: result.fixture.id,
      expected: result.fixture.expectedDecision,
      actual: result.decision,
      requiresClassifier: result.fixture.requiresClassifier === true,
    }));

  return { byCategory, byGradeBand, mismatches };
}

function metric(results: readonly CaseResult[], isPositive: (result: CaseResult) => boolean, isPredicted: (result: CaseResult) => boolean): Metric {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const result of results) {
    const positive = isPositive(result);
    const predicted = isPredicted(result);
    if (positive && predicted) truePositives++;
    else if (predicted) falsePositives++;
    else if (positive) falseNegatives++;
  }
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: rate(truePositives, truePositives + falsePositives),
    recall: rate(truePositives, truePositives + falseNegatives),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
