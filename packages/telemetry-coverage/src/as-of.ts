/** S0b hypothesis only. Logical cuts are not time-prefix/frontier or final-bucket claims. */
export interface ProposedAsOfScope {
  readonly tenant: string; readonly streamId: string; readonly epoch: string; readonly membershipRevision: string;
}
export type ProposedAsOfFact =
  | { readonly kind: "completion"; readonly sequence: number; readonly completionId: string; readonly digest: string;
    readonly occurrenceBucket: number; readonly candidate: boolean }
  | { readonly kind: "checkpoint"; readonly checkpointId: number; readonly digest: string; readonly throughSequence: number };
export interface ProposedAsOfState {
  readonly scope: ProposedAsOfScope; readonly status: "open" | "capacity";
  readonly facts: readonly ProposedAsOfFact[];
  /** Abstract integer units, deliberately not a wire precision or approved TTL. */
  readonly clock: number; readonly countDeadline: number; readonly countsExpired: boolean;
  readonly validFromBucket: number; readonly revoked: boolean;
}
export type ProposedAsOfResult =
  | { readonly status: "unavailable"; readonly reason: "scope" | "capacity" | "count-invalid" | "checkpoint-unknown" | "conflict" | "prefix-missing" }
  | { readonly status: "scoped-as-of-model"; readonly scope: ProposedAsOfScope; readonly checkpointId: number; readonly throughSequence: number;
    readonly startBucket: number; readonly endBucket: number; readonly evaluated: number; readonly candidate: number;
    readonly final: false; readonly runtimeApproved: false };
const LIMIT = 64;
const label = (v: string) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
const scopeKey = (s: ProposedAsOfScope) => JSON.stringify([s.tenant, s.streamId, s.epoch, s.membershipRevision]);
const key = (f: ProposedAsOfFact) => JSON.stringify(f.kind === "completion" ? [f.kind, f.sequence, f.completionId, f.digest, f.occurrenceBucket, f.candidate]
  : [f.kind, f.checkpointId, f.digest, f.throughSequence]);

export function createProposedAsOf(scope: ProposedAsOfScope, countDeadline: number, validFromBucket: number): ProposedAsOfState {
  if (scope === null || typeof scope !== "object" || ![scope.tenant, scope.streamId, scope.epoch, scope.membershipRevision].every(label) ||
      !integer(countDeadline) || !integer(validFromBucket)) throw new Error("invalid proposed as-of scope");
  return Object.freeze({ scope: Object.freeze({ tenant: scope.tenant, streamId: scope.streamId, epoch: scope.epoch, membershipRevision: scope.membershipRevision }),
    status: "open", facts: Object.freeze([]), clock: 0, countDeadline, countsExpired: countDeadline === 0, validFromBucket, revoked: false });
}
export function applyProposedAsOfFact(state: ProposedAsOfState, fact: ProposedAsOfFact): ProposedAsOfState {
  if (state.status === "capacity") return state;
  if (fact === null || typeof fact !== "object" || typeof fact.digest !== "string" || !/^[a-f0-9]{64}$/.test(fact.digest)) throw new Error("invalid proposed as-of fact");
  let copy: ProposedAsOfFact;
  if (fact.kind === "completion" && integer(fact.sequence) && fact.sequence > 0 && label(fact.completionId) &&
      integer(fact.occurrenceBucket) && typeof fact.candidate === "boolean") copy = Object.freeze({ kind: fact.kind, sequence: fact.sequence,
    completionId: fact.completionId, digest: fact.digest, occurrenceBucket: fact.occurrenceBucket, candidate: fact.candidate });
  else if (fact.kind === "checkpoint" && integer(fact.checkpointId) && fact.checkpointId > 0 && integer(fact.throughSequence)) copy = Object.freeze({
    kind: fact.kind, checkpointId: fact.checkpointId, digest: fact.digest, throughSequence: fact.throughSequence });
  else throw new Error("invalid proposed as-of fact");
  if (state.facts.some((f) => key(f) === key(copy))) return state;
  if (state.facts.length >= LIMIT) return Object.freeze({ ...state, status: "capacity", facts: Object.freeze([]) });
  return Object.freeze({ ...state, facts: Object.freeze([...state.facts, copy].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) });
}
export function advanceProposedAsOfClock(state: ProposedAsOfState, now: number): ProposedAsOfState {
  if (!integer(now)) throw new Error("invalid proposed model clock");
  const clock = Math.max(state.clock, now);
  return Object.freeze({ ...state, clock, countsExpired: state.countsExpired || clock >= state.countDeadline });
}
/** Applied shortening, expiry, loss and revocation cannot be undone in the same scope. */
export function clampProposedCountDeadline(state: ProposedAsOfState, deadline: number): ProposedAsOfState {
  if (!integer(deadline)) throw new Error("invalid proposed deadline");
  const countDeadline = Math.min(state.countDeadline, deadline);
  return Object.freeze({ ...state, countDeadline, countsExpired: state.countsExpired || state.clock >= countDeadline });
}
export function invalidateProposedCountsBefore(state: ProposedAsOfState, bucket: number): ProposedAsOfState {
  if (!integer(bucket)) throw new Error("invalid proposed count horizon");
  return Object.freeze({ ...state, validFromBucket: Math.max(state.validFromBucket, bucket) });
}
export const revokeProposedAsOf = (state: ProposedAsOfState): ProposedAsOfState => Object.freeze({ ...state, revoked: true });

/**
 * Conditional finite proof: each completion fact atomically contains presence AND its count unit;
 * the source's checkpoint names an exact logical commit cut. Those are assumptions, not attestation.
 */
export function readProposedAsOf(state: ProposedAsOfState, query: { readonly scope: ProposedAsOfScope; readonly checkpointId: number;
  readonly startBucket: number; readonly endBucket: number }): ProposedAsOfResult {
  if (!integer(query.checkpointId) || query.checkpointId === 0 || !integer(query.startBucket) || !integer(query.endBucket) || query.startBucket >= query.endBucket) throw new Error("invalid proposed query");
  const unavailable = (reason: Extract<ProposedAsOfResult, { status: "unavailable" }>["reason"]): ProposedAsOfResult => ({ status: "unavailable", reason });
  if (scopeKey(state.scope) !== scopeKey(query.scope)) return unavailable("scope");
  if (state.status === "capacity") return unavailable("capacity");
  if (state.countsExpired || state.revoked || query.startBucket < state.validFromBucket) return unavailable("count-invalid");
  const completions = state.facts.filter((f) => f.kind === "completion"), checkpoints = state.facts.filter((f) => f.kind === "checkpoint");
  const sequence = new Set<number>(), ids = new Set<string>(), digests = new Set<string>(), checkpointIds = new Set<number>();
  for (const f of completions) {
    if (sequence.has(f.sequence) || ids.has(f.completionId) || digests.has(f.digest)) return unavailable("conflict");
    sequence.add(f.sequence); ids.add(f.completionId); digests.add(f.digest);
  }
  const sorted = [...checkpoints].sort((a, b) => a.checkpointId - b.checkpointId);
  for (const [i, f] of sorted.entries()) {
    if (checkpointIds.has(f.checkpointId) || digests.has(f.digest) ||
        (i > 0 && sorted[i - 1]!.throughSequence > f.throughSequence)) return unavailable("conflict");
    checkpointIds.add(f.checkpointId);
    digests.add(f.digest);
  }
  const cut = checkpoints.find((f) => f.checkpointId === query.checkpointId);
  if (cut === undefined) return unavailable("checkpoint-unknown");
  // Finite bound also prevents a hostile huge sequence from making an unbounded scan.
  if (cut.throughSequence > completions.length) return unavailable("prefix-missing");
  for (let n = 1; n <= cut.throughSequence; n++) if (!sequence.has(n)) return unavailable("prefix-missing");
  const cohort = completions.filter((f) => f.sequence <= cut.throughSequence && f.occurrenceBucket >= query.startBucket && f.occurrenceBucket < query.endBucket);
  return Object.freeze({ status: "scoped-as-of-model", scope: state.scope, checkpointId: cut.checkpointId, throughSequence: cut.throughSequence,
    startBucket: query.startBucket, endBucket: query.endBucket, evaluated: cohort.length, candidate: cohort.filter((f) => f.candidate).length,
    final: false, runtimeApproved: false });
}
