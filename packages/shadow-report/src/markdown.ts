import { DECISION_PRECEDENCE } from "@gmacko/hall-monitor-policy";
import type { DecisionCounts, DecisionDiffReport, ShadowReport } from "./report.ts";

const DECISIONS = [...DECISION_PRECEDENCE].reverse();

/** Renders a shadow report as Markdown. Text appears only if the report already carries it. */
export function renderShadowMarkdown(report: ShadowReport): string {
  const { configuration: config, cost } = report;
  const lines = [
    "# Hall Monitor shadow report",
    "",
    `Generated ${report.generatedAt} over ${report.corpus.cases} synthetic cases (\`${report.corpus.source}\`).`,
    "",
    `- Policy: ${config.policy} (${Object.entries(config.policyRevisions).map(([id, revision]) => `\`${id}@${revision}\``).join(", ") || "none"})`,
    `- Resolver: \`${config.resolverVersion}\`; evaluator bundle: \`${config.evaluatorBundleRevision ?? "n/a"}\``,
    `- Classifier: ${config.classifier}; price book: \`${config.priceBookId}\``,
    "",
    "## Decision distribution",
    "",
    ...countsTable("Profile", { all: report.distribution.overall, ...report.distribution.byProfile }),
    "",
    ...countsTable("Grade band", report.distribution.byGradeBand),
    "",
    ...countsTable("Category", report.distribution.byCategory),
    "",
    "## Agreement with expected decisions",
    "",
    "| Profile | Agreed | Total | Rate |",
    "|---|---:|---:|---:|",
    ...Object.entries({ all: report.agreement.overall, ...report.agreement.byProfile }).map(
      ([name, a]) => `| ${name} | ${a.agreed} | ${a.total} | ${percent(a.rate)} |`,
    ),
    "",
    "## Detection quality",
    "",
    "| Category | Precision | Recall | TP | FP | FN |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.quality.byCategory).map(
      ([name, m]) => `| ${name} | ${percent(m.precision)} | ${percent(m.recall)} | ${m.truePositives} | ${m.falsePositives} | ${m.falseNegatives} |`,
    ),
    "",
    "| Grade band | Cases | Precision | Recall | Decision accuracy |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(report.quality.byGradeBand).map(
      ([name, m]) => `| ${name} | ${m.cases} | ${percent(m.precision)} | ${percent(m.recall)} | ${percent(m.decisionAccuracy)} |`,
    ),
    "",
    `Mismatches (${report.quality.mismatches.length}):`,
    "",
    ...(report.quality.mismatches.length === 0
      ? ["- none"]
      : report.quality.mismatches.map(
          (m) => `- \`${m.id}\`: expected ${m.expected}, got ${m.actual}${m.requiresClassifier ? " (needs classifier)" : ""}${m.text === undefined ? "" : ` — "${escape(m.text)}"`}`,
        )),
    "",
    "## Latency (measured, ms)",
    "",
    "| Stage | Samples | p50 | p95 | max |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(report.latencyMs).map(([stage, s]) => `| ${stage} | ${s.samples} | ${ms(s.p50Ms)} | ${ms(s.p95Ms)} | ${ms(s.maxMs)} |`),
    "",
    "## Estimated gross cost",
    "",
    `- Basis: ${cost.basis}${cost.basis === "simulated" ? " (fake classifier: usage is estimated, not measured)" : ""}`,
    `- ${cost.evaluations} evaluations, ${cost.billedEvaluations} with a receipt, ${cost.attempts} provider attempts, ${cost.escalations} escalations`,
    `- Total ${cost.totalGrossUsdNano} nanodollars; **${cost.grossUsdPer1000} per 1,000 evaluations** (${cost.grossUsdNanoPer1000} nanodollars)`,
    ...(cost.unknownCostEvaluations > 0 ? [`- ${cost.unknownCostEvaluations} evaluations have unknown cost: the totals are lower bounds`] : []),
    ...(report.errors.length === 0 ? [] : ["", `Errors: ${report.errors.map((e) => `\`${e.id}\` ${e.code}`).join(", ")}`]),
    "",
  ];
  return lines.join("\n");
}

/** Renders a decision diff as Markdown. Text appears only if the report already carries it. */
export function renderDiffMarkdown(report: DecisionDiffReport): string {
  const variant = (v: DecisionDiffReport["baseline"]) =>
    `${v.label} (${Object.entries(v.policyRevisions).map(([id, revision]) => `\`${id}@${revision}\``).join(", ")}; \`${v.resolverVersion}\`)` +
    (v.clampedFields.length === 0 ? "" : `; clamped: ${v.clampedFields.map((field) => `\`${field}\``).join(", ")}`);
  const lines = [
    "# Hall Monitor decision diff",
    "",
    `Generated ${report.generatedAt} over ${report.corpus.cases} synthetic cases (\`${report.corpus.source}\`), classifier ${report.classifier}.`,
    "",
    `- Baseline: ${variant(report.baseline)}`,
    `- Candidate: ${variant(report.candidate)}`,
    `- **${report.changed} decisions changed**; ${report.reasonCodesOnlyChanged} cases changed reason codes only`,
    `- Agreement with expected: baseline ${percent(report.agreement.baseline.rate)}, candidate ${percent(report.agreement.candidate.rate)}`,
    "",
    "## Transitions",
    "",
    ...(report.changed === 0 ? ["- none"] : ["| From → to | Cases |", "|---|---:|", ...Object.entries(report.transitions).map(([t, n]) => `| ${t.replace("->", " → ")} | ${n} |`)]),
    "",
    "## By reason code",
    "",
    ...(Object.keys(report.byReasonCode).length === 0
      ? ["- none"]
      : [
          "| Reason code | Changed cases | Appeared in | Disappeared from |",
          "|---|---|---|---|",
          ...Object.entries(report.byReasonCode).map(
            ([code, ids]) => `| \`${code}\` | ${ids.cases.join(", ")} | ${ids.added.join(", ") || "—"} | ${ids.removed.join(", ") || "—"} |`,
          ),
        ]),
    "",
    "## Changed cases",
    "",
    ...(report.changes.length === 0
      ? ["- none"]
      : [
          "| Case | Profile | Band | Category | Expected | From | To |",
          "|---|---|---|---|---|---|---|",
          ...report.changes.map((c) => `| \`${c.id}\`${c.text === undefined ? "" : ` "${escape(c.text)}"`} | ${c.profileId} | ${c.gradeBand} | ${c.category} | ${c.expected} | ${c.from} | ${c.to} |`),
        ]),
    ...(report.errors.length === 0 ? [] : ["", `Errors: ${report.errors.map((e) => `\`${e.id}\` (${e.variant}) ${e.code}`).join(", ")}`]),
    "",
  ];
  return lines.join("\n");
}

function countsTable(heading: string, groups: Readonly<Record<string, DecisionCounts | undefined>>): string[] {
  return [
    `| ${heading} | ${DECISIONS.join(" | ")} | total |`,
    `|---|${DECISIONS.map(() => "---:").join("|")}|---:|`,
    ...Object.entries(groups).map(([name, counts = {}]) => {
      const values = DECISIONS.map((decision) => counts[decision] ?? 0);
      return `| ${name} | ${values.join(" | ")} | ${values.reduce((a, b) => a + b, 0)} |`;
    }),
  ];
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function ms(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function escape(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[|`]/g, "\\$&");
}
