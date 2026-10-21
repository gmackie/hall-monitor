import { SYSTEM_REASON_CODES } from "@gmacko/hall-monitor-policy";
import { fixtureProfileId } from "@gmacko/hall-monitor-test-fixtures";
import type { CaseSet } from "./cases.ts";
import { classifierLabel } from "./classifier.ts";
import { DecisionDiffReport, type DecisionChange, REPORT_VERSION } from "./report.ts";
import { agreement, type CaseEvaluation, evaluateCases, type RunOptions } from "./run.ts";
import type { PolicyVariant } from "./variant.ts";

/** Options for {@link diffDecisions}: the shared run settings, minus the variant. */
export type DiffOptions = Omit<RunOptions, "variant">;

/**
 * Evaluates the same frozen corpus under a baseline and a candidate variant and reports every
 * case whose decision changed, grouped by transition and by the reason codes that appeared or
 * disappeared. The classifier must be deterministic (none or fake) for the diff to isolate the
 * policy change; a real classifier can differ between the two runs on its own.
 */
export async function diffDecisions(set: CaseSet, baseline: PolicyVariant, candidate: PolicyVariant, options: DiffOptions = {}): Promise<DecisionDiffReport> {
  const before = await evaluateCases(set, { ...options, variant: baseline });
  const after = await evaluateCases(set, { ...options, variant: candidate });
  return buildDiffReport(set, baseline, candidate, before, after, options);
}

/** Builds a decision diff from two evaluations of the same cases, in the same order. */
export function buildDiffReport(
  set: CaseSet,
  baseline: PolicyVariant,
  candidate: PolicyVariant,
  before: readonly CaseEvaluation[],
  after: readonly CaseEvaluation[],
  options: DiffOptions = {},
): DecisionDiffReport {
  const changes: DecisionChange[] = [];
  const transitions: Record<string, number> = {};
  const byReasonCode: Record<string, { cases: string[]; added: string[]; removed: string[] }> = {};
  let reasonCodesOnlyChanged = 0;
  const errors: DecisionDiffReport["errors"] = [];

  for (const [index, old] of before.entries()) {
    const next = after[index]!;
    if (old.errorCode !== undefined) errors.push({ id: old.fixture.id, variant: "baseline", code: old.errorCode });
    if (next.errorCode !== undefined) errors.push({ id: next.fixture.id, variant: "candidate", code: next.errorCode });
    if (old.result === undefined || next.result === undefined) continue;
    const from = new Set(effectiveCodes(old.result.reasonCodes));
    const to = new Set(effectiveCodes(next.result.reasonCodes));
    const added = [...to].filter((code) => !from.has(code)).sort();
    const removed = [...from].filter((code) => !to.has(code)).sort();
    if (old.result.decision === next.result.decision) {
      if (added.length > 0 || removed.length > 0) reasonCodesOnlyChanged++;
      continue;
    }
    const transition = `${old.result.decision}->${next.result.decision}`;
    transitions[transition] = (transitions[transition] ?? 0) + 1;
    const entry = (code: string) => (byReasonCode[code] ??= { cases: [], added: [], removed: [] });
    for (const code of [...new Set([...from, ...to])].sort()) entry(code).cases.push(old.fixture.id);
    for (const code of added) entry(code).added.push(old.fixture.id);
    for (const code of removed) entry(code).removed.push(old.fixture.id);
    changes.push({
      id: old.fixture.id,
      profileId: fixtureProfileId(old.fixture),
      gradeBand: old.fixture.gradeBand,
      category: old.fixture.category,
      expected: old.fixture.expectedDecision,
      from: old.result.decision,
      to: next.result.decision,
      reasonCodesAdded: added,
      reasonCodesRemoved: removed,
      ...(options.includeText === true ? { text: old.fixture.text } : {}),
    });
  }

  const decided = (evaluations: readonly CaseEvaluation[]) =>
    evaluations.flatMap((evaluation) => (evaluation.result === undefined ? [] : [{ fixture: evaluation.fixture, result: evaluation.result }]));
  return DecisionDiffReport.parse({
    reportVersion: REPORT_VERSION,
    kind: "decision-diff",
    generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    corpus: { source: set.source, cases: set.cases.length },
    classifier: classifierLabel(options.classifier ?? { kind: "fake" }),
    baseline: summary(baseline, before),
    candidate: summary(candidate, after),
    changed: changes.length,
    reasonCodesOnlyChanged,
    transitions: Object.fromEntries(Object.entries(transitions).sort(([a], [b]) => a.localeCompare(b))),
    byReasonCode: Object.fromEntries(Object.entries(byReasonCode).sort(([a], [b]) => a.localeCompare(b))),
    agreement: { baseline: agreement(decided(before)), candidate: agreement(decided(after)) },
    changes,
    errors,
  });
}

/** Reason codes that describe the content or policy, without the shadow marker. */
function effectiveCodes(codes: readonly string[]): string[] {
  return codes.filter((code) => code !== SYSTEM_REASON_CODES.shadow);
}

function summary(variant: PolicyVariant, evaluations: readonly CaseEvaluation[]) {
  const profiles = [...new Set(evaluations.map((evaluation) => evaluation.profileId))].sort();
  return {
    label: variant.label,
    policyRevisions: Object.fromEntries(profiles.flatMap((id) => (Object.hasOwn(variant.profiles, id) ? [[id, variant.profiles[id]!.revision]] : []))),
    resolverVersion: variant.resolverVersion,
    clampedFields: [...variant.clampedFields],
  };
}
