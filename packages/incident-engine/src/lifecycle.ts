import type { VerifiedSafetyEvent } from "@gmacko/hall-monitor-safety-events";
import type { SyntheticCaseLedger } from "./assertions.ts";

export interface SyntheticRecordState {
  readonly recordId: string;
  readonly status: "active" | "expired" | "retracted" | "conflict" | "pending" | "invalid" | "dependency-unavailable";
  readonly current: VerifiedSafetyEvent | undefined;
}
/** Source causal versions win over arrival time; contradictory variants remain permanently tainted. */
export function resolveSyntheticRecords(ledger: SyntheticCaseLedger, now: number): readonly SyntheticRecordState[] {
  const grouped = new Map<string, VerifiedSafetyEvent[]>();
  for (const fact of ledger.facts) grouped.set(fact.event.recordId, [...(grouped.get(fact.event.recordId) ?? []), fact]);
  const records = new Map<string, SyntheticRecordState>();
  for (const [recordId, facts] of grouped) {
    const versions = new Map<number, VerifiedSafetyEvent[]>();
    for (const f of facts) versions.set(f.event.version, [...(versions.get(f.event.version) ?? []), f]);
    const sorted = [...versions.keys()].sort((a, b) => a - b);
    let status: SyntheticRecordState["status"] = "active";
    let previous: VerifiedSafetyEvent | undefined;
    if ([...versions.values()].some((v) => v.length > 1)) status = "conflict";
    else for (let i = 0; i < sorted.length; i++) {
      const version = sorted[i]!, current = versions.get(version)![0]!;
      if (version !== i + 1) { status = "pending"; break; }
      const event = current.event, prior = previous?.event;
      if (previous !== undefined && (event.previousDigest !== previous.digest || event.producerId !== prior!.producerId ||
          event.category !== prior!.category || prior!.assertion.kind === "record.retracted" ||
          (event.assertion.kind !== "record.retracted" && event.assertion.kind !== prior!.assertion.kind))) { status = "invalid"; break; }
      if (event.revisionKind === "transition") {
        const a = event.assertion, b = prior?.assertion;
        if (a.kind !== "permission.transition" || b?.kind !== "permission.transition" || a.target.token !== b.target.token ||
            a.group.token !== b.group.token || a.from !== b.to || Date.parse(event.occurredAt) < Date.parse(prior!.occurredAt)) { status = "invalid"; break; }
      }
      previous = current;
    }
    if (status === "active" && previous !== undefined) {
      if (previous.event.assertion.kind === "record.retracted") status = "retracted";
      else if (now >= Date.parse(previous.event.expiresAt)) status = "expired";
    }
    records.set(recordId, { recordId, status, current: status === "active" ? previous : undefined });
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function dependenciesAvailable(id: string): boolean {
    const record = records.get(id);
    if (record?.status !== "active") return false;
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const available = record.current!.event.dependencies.every((d) => {
      const dependency = records.get(d.recordId);
      return dependency?.current?.digest === d.digest && dependenciesAvailable(d.recordId);
    });
    visiting.delete(id);
    if (!available) records.set(id, { recordId: id, status: "dependency-unavailable", current: undefined });
    else visited.add(id);
    return available;
  }
  for (const id of records.keys()) dependenciesAvailable(id);
  return [...records.values()].sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
}
