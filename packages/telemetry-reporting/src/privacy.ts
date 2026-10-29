import { freezeReportingValue, SyntheticRelease, type CellState, type SyntheticReportingCell, type SyntheticReportingResponse } from "./contracts.ts";

/** One flat partition: no totals, alternate filters, raw records or overlapping/corrected releases. */
export function projectSyntheticRelease(input: unknown, now: number): SyntheticReportingResponse {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new Error("invalid reporting clock");
  const parsed = SyntheticRelease.safeParse(input);
  if (!parsed.success) throw new Error("invalid synthetic reporting release");
  const r = parsed.data;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: r.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const localDate = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
  const windowEnded = Date.parse(localDate) >= Date.parse(r.firstLocalDate) + r.days * 86_400_000;
  const cells: SyntheticReportingCell[] = [...r.cells].sort((a, b) => a.cell - b.cell).map((c) => {
    const unavailable = (state: CellState): SyntheticReportingCell => ({ cell: c.cell, evaluated: { state, value: null },
      candidateRate: { state, value: null }, coverage: state === "expired" || state === "source-unavailable" ? "unavailable" : c.coverage });
    if (now >= r.validUntil || now >= c.countsValidUntil) return unavailable("expired");
    if (!windowEnded || r.source === "unavailable" || c.evaluated === null || c.candidates === null || c.coverage === "unavailable") return unavailable("source-unavailable");
    if (c.coverage !== "as-of-fixture") return unavailable("incomplete-coverage");
    if (r.population === null || r.population < r.policy.minimumPopulation) return unavailable("suppressed");
    if (c.evaluated > 0 && c.evaluated < r.policy.minimumEvaluated) return unavailable("insufficient-exposure");
    const rateState: CellState = c.evaluated === 0 ? "insufficient-exposure" :
      c.candidates < r.policy.minimumCandidate || c.evaluated - c.candidates < r.policy.minimumCandidate ? "suppressed" : "measured-fixture";
    return { cell: c.cell, evaluated: { state: "measured-fixture", value: c.evaluated },
      candidateRate: { state: rateState, value: rateState === "measured-fixture" ? c.candidates / c.evaluated : null }, coverage: c.coverage };
  });
  return freezeReportingValue({ schemaVersion: "1.0", mode: "synthetic", activation: "not-approved", releaseId: r.releaseId, cohort: r.cohort,
    dataRevision: r.dataRevision, cohortRevision: r.cohortRevision, firstLocalDate: r.firstLocalDate, days: r.days,
    timezone: r.timezone, calendarRevision: r.calendarRevision, cells,
    capabilities: { evaluated: "fixture-only", candidateRate: "fixture-only", liveCoverage: "unavailable", reports: "unavailable", cases: "unavailable", urgentQueue: "unavailable", cost: "unavailable" } });
}

/** Export only the exact already-redacted DTO, with identical cell order and no hidden totals. */
export function syntheticReportingCsv(response: SyntheticReportingResponse): string {
  const rows = ["cell,evaluated_state,evaluated,candidate_rate_state,candidate_rate,coverage"];
  for (const c of response.cells) rows.push([c.cell, c.evaluated.state, c.evaluated.value ?? "", c.candidateRate.state, c.candidateRate.value ?? "", c.coverage].join(","));
  return rows.join("\n") + "\n";
}
