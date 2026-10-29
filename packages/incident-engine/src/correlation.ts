import { freezeSafetyValue } from "@gmacko/hall-monitor-safety-events";
import type { SyntheticCaseLedger } from "./assertions.ts";
import { resolveSyntheticRecords, type SyntheticRecordState } from "./lifecycle.ts";

export const SYNTHETIC_REVIEW_RUBRIC = "synthetic-review-1";
export interface SyntheticHypothesis {
  readonly reason: "required-access-review" | "reported-concern-review" | "model-context-review" | "attribution-unresolved";
  readonly recordIds: readonly string[];
  readonly action: "qualified-human-review";
}
export type SyntheticCaseSummary =
  | { readonly mode: "synthetic"; readonly status: "capacity" | "clock-invalid"; readonly activation: "not-approved" }
  | { readonly mode: "synthetic"; readonly status: "ready" | "incomplete"; readonly activation: "not-approved";
    readonly rubric: string; readonly records: readonly SyntheticRecordState[]; readonly hypotheses: readonly SyntheticHypothesis[];
    readonly reportCount: number; readonly sourceAttestedIndependentGroups: number; readonly unresolvedReports: number;
    readonly disclosure: "unavailable"; readonly discipline: "unavailable" };

/** Fixed synthetic review rubric, not a live safeguarding score or student reputation. */
export function summarizeSyntheticCase(ledger: SyntheticCaseLedger, now: number): SyntheticCaseSummary {
  if (ledger.state === "capacity") return { mode: "synthetic", status: "capacity", activation: "not-approved" };
  if (!Number.isSafeInteger(now) || now < 0 || ledger.facts.some((f) => now < f.receivedAt)) return { mode: "synthetic", status: "clock-invalid", activation: "not-approved" };
  const records = resolveSyntheticRecords(ledger, now), active = records.filter((r) => r.status === "active");
  const hypotheses: SyntheticHypothesis[] = [];
  const permissionKeys = new Map<string, string>();
  let parallelPermissionHistories = false;
  for (const fact of ledger.facts) {
    const a = fact.event.assertion;
    if (a.kind !== "permission.transition") continue;
    const key = JSON.stringify([a.group.token, a.target.token]);
    if (permissionKeys.has(key) && permissionKeys.get(key) !== fact.event.recordId) parallelPermissionHistories = true;
    permissionKeys.set(key, fact.event.recordId);
  }
  const reportGroups: { recordId: string; group: string; evidence: string }[] = [];
  let reportCount = 0, unresolvedReports = 0;
  for (const r of active) {
    const a = r.current!.event.assertion;
    const add = (reason: SyntheticHypothesis["reason"]) => hypotheses.push({ reason, recordIds: [r.recordId], action: "qualified-human-review" });
    if (a.kind === "permission.transition") {
      if (a.to === "removed" && a.purpose === "required-group-work") add("required-access-review");
    } else if (a.kind === "report.allegation") {
      reportCount++;
      add(a.subjects.length === 1 ? "reported-concern-review" : "attribution-unresolved");
      if (a.subjects.length !== 1) unresolvedReports++;
      if (a.independence === "source-verified" && a.provenance === "source-message" && a.speechAct !== "forwarded-rumor" && a.speechAct !== "quoted-material")
        reportGroups.push({ recordId: r.recordId, group: a.evidenceGroup.token, evidence: a.evidence.token });
    } else if (a.kind === "model.assertion") add(a.subjects.length === 1 ? "model-context-review" : "attribution-unresolved");
  }
  // Transitive grouping: a shared source artifact OR origin group prevents recounting copies.
  const parent = reportGroups.map((_, i) => i);
  function root(i: number): number { while (parent[i] !== i) i = parent[i]!; return i; }
  for (let i = 0; i < reportGroups.length; i++) for (let j = 0; j < i; j++) {
    if (reportGroups[i]!.group === reportGroups[j]!.group || reportGroups[i]!.evidence === reportGroups[j]!.evidence) parent[root(i)] = root(j);
  }
  const incomplete = parallelPermissionHistories || records.some((r) => ["conflict", "pending", "invalid", "dependency-unavailable"].includes(r.status));
  return freezeSafetyValue({ mode: "synthetic", status: incomplete ? "incomplete" : "ready", activation: "not-approved", rubric: SYNTHETIC_REVIEW_RUBRIC,
    records, hypotheses: parallelPermissionHistories ? hypotheses.filter((h) => h.reason !== "required-access-review") : hypotheses,
    reportCount, sourceAttestedIndependentGroups: new Set(reportGroups.map((_, i) => root(i))).size, unresolvedReports,
    disclosure: "unavailable", discipline: "unavailable" });
}
