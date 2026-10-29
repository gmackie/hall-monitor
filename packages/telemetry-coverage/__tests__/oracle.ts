// Independent test-only ground truth. Never imports the evidence reducer or a candidate verdict.
import type { ExperimentalEvidenceScope } from "../src/index.ts";

export interface SyntheticCompletion {
  readonly completionId: string;
  readonly scope: ExperimentalEvidenceScope;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly commitOrder: number;
  readonly committedAt: number;
  readonly candidate: boolean;
}

const key = (scope: ExperimentalEvidenceScope) => JSON.stringify([scope.tenant, scope.streamId, scope.epoch]);
const label = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const positiveInteger = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;
const time = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** Frozen completed work, not received deliveries. All commits contribute even if never delivered. */
export function completionLedger(input: readonly SyntheticCompletion[]): readonly SyntheticCompletion[] {
  const scopes = new Map<string, SyntheticCompletion[]>();
  const identities = new Set<string>();
  const entries = input.map((entry) => {
    if (!label(entry.completionId) || !label(entry.scope.tenant) || !label(entry.scope.streamId) || !label(entry.scope.epoch) ||
        !positiveInteger(entry.sequence) || !positiveInteger(entry.commitOrder) || !time(entry.occurredAt) || !time(entry.committedAt) ||
        typeof entry.candidate !== "boolean") throw new TypeError("invalid synthetic completion");
    const identity = JSON.stringify([key(entry.scope), entry.completionId]);
    if (identities.has(identity)) throw new TypeError("duplicate synthetic completion identity");
    identities.add(identity);
    const copied = Object.freeze({ ...entry, scope: Object.freeze({ ...entry.scope }) });
    const group = scopes.get(key(entry.scope)) ?? [];
    group.push(copied);
    scopes.set(key(entry.scope), group);
    return copied;
  });
  for (const group of scopes.values()) {
    group.sort((a, b) => a.commitOrder - b.commitOrder);
    for (let i = 0; i < group.length; i++) {
      const current = group[i]!;
      const previous = group[i - 1];
      if (current.sequence !== i + 1 || (previous !== undefined &&
          (previous.commitOrder === current.commitOrder || previous.committedAt > current.committedAt))) {
        throw new TypeError("contradictory synthetic sequence or logical commit order");
      }
    }
  }
  return Object.freeze(entries);
}

export function committedThrough(ledger: readonly SyntheticCompletion[], scope: ExperimentalEvidenceScope, through: number): readonly SyntheticCompletion[] {
  return ledger.filter((entry) => key(entry.scope) === key(scope) && entry.committedAt <= through);
}

export function oracleCounts(ledger: readonly SyntheticCompletion[], scope: ExperimentalEvidenceScope, start: number, end: number, through = Infinity) {
  const entries = committedThrough(ledger, scope, through).filter((e) => start <= e.occurredAt && e.occurredAt < end);
  return { evaluated: entries.length, candidate: entries.filter((e) => e.candidate).length };
}

/** Count validity is independently tracked and can only shorten after a policy was applied. */
export interface SyntheticCountWitness {
  readonly deadline: number;
  readonly deleted: boolean;
  readonly revoked: boolean;
}
export function clampCountValidity(witness: SyntheticCountWitness, deadline: number): SyntheticCountWitness {
  if (!time(deadline)) throw new TypeError("invalid synthetic count deadline");
  return { ...witness, deadline: Math.min(witness.deadline, deadline) };
}
export function oracleCountAvailability(witness: SyntheticCountWitness | null, now: number): "available" | "expired" | "revoked" | "unknown" {
  if (witness === null) return "unknown";
  if (witness.revoked) return "revoked";
  return witness.deleted || now >= witness.deadline ? "expired" : "available";
}
