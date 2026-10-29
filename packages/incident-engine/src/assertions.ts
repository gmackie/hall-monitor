import { freezeSafetyValue, isVerifiedSafetyEvent, SafetyScope, type VerifiedSafetyEvent } from "@gmacko/hall-monitor-safety-events";

/** Small immutable fixture bound. Capacity is terminal; no conflict evidence is evicted. */
export const SYNTHETIC_CASE_FACT_LIMIT = 256;
export interface SyntheticCaseLedger {
  readonly scope: SafetyScope;
  readonly state: "open" | "capacity";
  readonly facts: readonly VerifiedSafetyEvent[];
}
export function createSyntheticCase(scope: SafetyScope): SyntheticCaseLedger {
  const parsed = SafetyScope.safeParse(scope);
  if (!parsed.success) throw new Error("invalid synthetic case scope");
  return freezeSafetyValue({ scope: parsed.data, state: "open", facts: [] });
}
export function ingestSyntheticAssertion(ledger: SyntheticCaseLedger, fact: VerifiedSafetyEvent): SyntheticCaseLedger {
  if (!isVerifiedSafetyEvent(fact) || fact.event.scope.tenantId !== ledger.scope.tenantId || fact.event.scope.caseId !== ledger.scope.caseId) throw new Error("unverified or mismatched synthetic assertion");
  if (ledger.state === "capacity" || ledger.facts.some((f) => f.digest === fact.digest)) return ledger;
  if (ledger.facts.length >= SYNTHETIC_CASE_FACT_LIMIT) return freezeSafetyValue({ scope: ledger.scope, state: "capacity", facts: [] });
  return freezeSafetyValue({ ...ledger, facts: [...ledger.facts, fact].sort((a, b) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0) });
}
