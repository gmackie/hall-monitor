/** In-memory experimental facts, assumed authenticated for a named synthetic scope. No wire format. */
export interface ExperimentalEvidenceScope {
  readonly tenant: string;
  readonly streamId: string;
  readonly epoch: string;
}

export interface ExperimentalDeliveryFact {
  readonly kind: "delivery";
  readonly scope: ExperimentalEvidenceScope;
  readonly deliveryId: string;
  readonly digest: string;
  readonly sequence: number;
}

export interface ExperimentalCheckpointFact {
  readonly kind: "checkpoint";
  readonly scope: ExperimentalEvidenceScope;
  readonly checkpointSequence: number;
  readonly digest: string;
  readonly accountedSequence: number;
}

export type ExperimentalEvidenceFact = ExperimentalDeliveryFact | ExperimentalCheckpointFact;
export const EXPERIMENTAL_FACT_LIMIT = 64;

/** Capacity is terminal and deliberately carries no prior successful summary. JSON serializable. */
export type ExperimentalEvidenceState =
  | { readonly kind: "open"; readonly facts: readonly ExperimentalEvidenceFact[] }
  | { readonly kind: "capacity"; readonly limit: 64 };

export interface ExperimentalEvidenceConflict {
  readonly kind: "delivery_identity" | "delivery_sequence" | "checkpoint_identity";
  readonly identity: string;
  readonly variants: readonly string[];
}

export type ExperimentalEvidenceSummary =
  | { readonly kind: "capacity"; readonly limit: 64 }
  | {
    readonly kind: "observed";
    readonly scope: ExperimentalEvidenceScope;
    readonly deliveries: readonly ExperimentalDeliveryFact[];
    readonly checkpoints: readonly ExperimentalCheckpointFact[];
    /** Presence only: conflicts remain visible. This is not an acknowledged or temporal frontier. */
    readonly deliveredSequences: readonly number[];
    readonly contiguousSequence: number;
    readonly conflicts: readonly ExperimentalEvidenceConflict[];
  };

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const integer = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
const text = (s: string) => typeof s === "string" && LABEL.test(s);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const scopeKey = (s: ExperimentalEvidenceScope) => JSON.stringify([s.tenant, s.streamId, s.epoch]);
const factKey = (f: ExperimentalEvidenceFact) => JSON.stringify(f.kind === "delivery"
  ? [f.kind, scopeKey(f.scope), f.deliveryId, f.digest, f.sequence]
  : [f.kind, scopeKey(f.scope), f.checkpointSequence, f.digest, f.accountedSequence]);

function checkScope(scope: ExperimentalEvidenceScope): void {
  if (scope === null || typeof scope !== "object" || !text(scope.tenant) || !text(scope.streamId) || !text(scope.epoch)) {
    throw new TypeError("invalid experimental evidence scope");
  }
}

function canonicalFact(fact: ExperimentalEvidenceFact): ExperimentalEvidenceFact {
  if (fact === null || typeof fact !== "object") throw new TypeError("invalid experimental evidence fact");
  checkScope(fact.scope);
  if (typeof fact.digest !== "string" || !DIGEST.test(fact.digest)) throw new TypeError("invalid experimental evidence digest");
  const scope = Object.freeze({ tenant: fact.scope.tenant, streamId: fact.scope.streamId, epoch: fact.scope.epoch });
  if (fact.kind === "delivery" && integer(fact.sequence, 1) && text(fact.deliveryId)) {
    return Object.freeze({ kind: "delivery", scope, deliveryId: fact.deliveryId, digest: fact.digest, sequence: fact.sequence });
  }
  if (fact.kind === "checkpoint" && integer(fact.checkpointSequence, 1) && integer(fact.accountedSequence, 0)) {
    return Object.freeze({ kind: "checkpoint", scope, checkpointSequence: fact.checkpointSequence, digest: fact.digest, accountedSequence: fact.accountedSequence });
  }
  throw new TypeError("invalid experimental evidence fact");
}

export function emptyEvidence(): ExperimentalEvidenceState {
  return Object.freeze({ kind: "open", facts: Object.freeze([]) });
}

/** Pure set union within a finite bound: a contradictory variant is retained just like any fact. */
export function applyEvidence(state: ExperimentalEvidenceState, fact: ExperimentalEvidenceFact): ExperimentalEvidenceState {
  if (state.kind === "capacity") return state;
  const canonical = canonicalFact(fact);
  const key = factKey(canonical);
  if (state.facts.some((f) => factKey(f) === key)) return state;
  if (state.facts.length >= EXPERIMENTAL_FACT_LIMIT) return Object.freeze({ kind: "capacity", limit: EXPERIMENTAL_FACT_LIMIT });
  const facts = [...state.facts, canonical].sort((a, b) => compare(factKey(a), factKey(b)));
  return Object.freeze({ kind: "open", facts: Object.freeze(facts) });
}

/** Observe identities and finite sequence presence. Never infer count validity or finality. */
export function summarizeEvidence(state: ExperimentalEvidenceState, scope: ExperimentalEvidenceScope): ExperimentalEvidenceSummary {
  if (state.kind === "capacity") return state;
  checkScope(scope);
  const facts = state.facts.filter((f) => scopeKey(f.scope) === scopeKey(scope));
  const deliveries = facts.filter((f): f is ExperimentalDeliveryFact => f.kind === "delivery");
  const checkpoints = facts.filter((f): f is ExperimentalCheckpointFact => f.kind === "checkpoint");
  const deliveredSequences = [...new Set(deliveries.map((f) => f.sequence))].sort((a, b) => a - b);
  let contiguousSequence = 0;
  for (const sequence of deliveredSequences) {
    if (sequence !== contiguousSequence + 1) break;
    contiguousSequence = sequence;
  }
  const groups = new Map<string, { kind: ExperimentalEvidenceConflict["kind"]; identity: string; variants: string[] }>();
  const group = (kind: ExperimentalEvidenceConflict["kind"], identity: string, f: ExperimentalEvidenceFact) => {
    const key = JSON.stringify([kind, identity]);
    let entry = groups.get(key);
    if (entry === undefined) groups.set(key, entry = { kind, identity, variants: [] });
    entry.variants.push(factKey(f));
  };
  for (const f of deliveries) {
    group("delivery_identity", f.deliveryId, f);
    group("delivery_sequence", String(f.sequence), f);
  }
  for (const f of checkpoints) group("checkpoint_identity", String(f.checkpointSequence), f);
  const conflicts = [...groups.values()].filter((g) => g.variants.length > 1)
    .map((g) => ({ ...g, variants: g.variants.sort(compare) }))
    .sort((a, b) => compare(JSON.stringify([a.kind, a.identity]), JSON.stringify([b.kind, b.identity])));
  return {
    kind: "observed", scope: { ...scope }, deliveries, checkpoints,
    deliveredSequences, contiguousSequence, conflicts,
  };
}
