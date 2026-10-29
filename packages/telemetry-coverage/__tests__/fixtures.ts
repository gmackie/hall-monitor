import type { ExperimentalCheckpointFact, ExperimentalDeliveryFact, ExperimentalEvidenceScope } from "../src/index.ts";

export const SCOPE: ExperimentalEvidenceScope = { tenant: "synthetic-tenant", streamId: "synthetic-stream", epoch: "synthetic-epoch" };
export const digest = (n: number) => n.toString(16).padStart(64, "0");
export const delivery = (sequence: number, over: Partial<ExperimentalDeliveryFact> = {}): ExperimentalDeliveryFact =>
  ({ kind: "delivery", scope: SCOPE, sequence, deliveryId: `delivery-${sequence}`, digest: digest(sequence), ...over });
export const checkpoint = (checkpointSequence: number, accountedSequence: number, over: Partial<ExperimentalCheckpointFact> = {}): ExperimentalCheckpointFact =>
  ({ kind: "checkpoint", scope: SCOPE, checkpointSequence, accountedSequence, digest: digest(checkpointSequence + 100), ...over });

// FICTIONAL values, not approved retention durations or an approval reference.
export const policy = () => ({
  policyRevision: "synthetic-policy-1", approvalRef: "SYNTHETIC-NOT-AN-APPROVAL",
  effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2027-01-01T00:00:00Z",
  dedupeSeconds: 90_000, rollupSeconds: 180_000, healthSeconds: 3600,
  coverageSeconds: 270_000, gapSeconds: 360_000,
});
