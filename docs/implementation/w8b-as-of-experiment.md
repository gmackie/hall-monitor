# W8b S0b: qualified logical-cut experiment

This is a **proof hypothesis**, not a reviewed protocol or completed S0b. It extends only the
private finite `telemetry-coverage` experiment; neither Worker imports it. Live coverage remains
unavailable. It supplies no retention numbers, timestamp precision, wire fields, fence/tick,
approved E definition, receiver migration or tenant enrollment.

## The narrower statement

For one explicitly named tenant/stream/epoch/membership revision and source checkpoint, count
every committed evaluation in a requested occurrence-bucket interval whose **logical completion
sequence is at or below that checkpoint's cut**. The result says `scoped-as-of-model`, identifies
the exact cut and always has `final: false`, `runtimeApproved: false`.

It never says all work through a wall-clock instant was received, no pending request can later
complete into the bucket, the bucket is final, or one stream represents a whole district. A later
commit can change a later cut without changing the earlier cut's cohort. Equal-millisecond ties
are ordered by the transaction's logical sequence, not guessed from their timestamp. A late
checkpoint behind received presence is legitimate reordering. An unknown old checkpoint is
unknown, not evidence of restore and not permission to reconstruct zero.

This explicitly changes the proposed *claim*, not the denominator to delivered work. Within the
declared source cut, every committed completion must be present before any exact result. Dropped,
unprojectable, invalid-setting and degraded completions cannot be skipped from sequence assignment.
The owner confirmed E membership on 2026-10-29: every unique committed evaluation across all four
kinds, including degraded results. The experiment now names `all-committed-evaluations-v1`; see
[evaluated volume](evaluated-volume.md) for exclusions and real-store verification. This settles
product membership only; no production sequence, census or coverage claim follows from the name.

## Conditional argument and reachability

Assume (A1) the source assigns one gapless sequence per unique completion in the named scope;
(A2) checkpoint creation is serialized with completion commits and attests its exact sequence;
(A3) a received completion's presence and count unit are the same atomic fact; (A4) authenticated
facts bind every field and cannot be fabricated; (A5) the stored state/clock and loss history are
durable and cannot be rolled back unnoticed.

The model retains all distinct variants. If identities, sequences or checkpoint histories
conflict, it withholds. Otherwise it requires every sequence 1..N for the checkpoint. By A1–A4,
those are exactly the committed cohort through N. Filtering those facts by occurrence bucket
and counting their candidate subset therefore matches the independent completion ledger. A
checkpoint at N=0 makes an empty *named scope/cut* reachable; without the checkpoint zero is
unavailable. That is not evidence of no student activity or no completions before enrollment.

Clock advancement is explicit in this abstract state machine. Before a modeled read, advance
the trusted clock and preserve the returned state. An applied shorter deadline can only clamp
down, observed expiry is sticky, a discarded-count horizon can only advance and revocation
cannot be reversed in that scope. Read-time count validity is required even for a zero result.
Serialization/restart tests retain those facts. A fresh/reset state cannot prove past validity;
ignoring a transition or restoring an older snapshot violates A5 and is **not** solved here.

The finite state allows 64 distinct facts. Exact retries use no slot. The next distinct variant
enters a terminal unavailable state and cannot preserve an apparently clean prefix by evicting
contradictions. There is no proposed production compaction or checkpoint garbage collection.

Tests reach nonzero/zero states and reject the known counterexamples: expired nonzero data
cannot become zero; delayed checkpoints do not imply restore; equal-clock pending commits do
not justify a wall-time prefix; late prepared work changes a later logical cohort rather than
contradicting a claim of finality. An independent full-completion oracle checks every delivery
subset of four commits across five cuts, including undelivered work.

## Why this still cannot enable S1

The model stores a per-completion fact and count together. Today's receiver stores occurrence
rollups without a sequence-cut dimension. Applying the predicate to its current rollups would be
wrong: delivery presence ahead of a cut must not contaminate that cut's counts. A production
design must prove an exact aggregate snapshot/barrier or other cut accounting mechanism **without
unapproved per-message analytics rows**, with privacy-reviewed evidence retention and bounds.

Additional unresolved obligations:

- Source completion uniqueness, failed/retried completion behavior and transaction/savepoint semantics.
- Durable checkpoint creation/output-gate acknowledgments and undetectable source/receiver restore.
- A complete expected-stream and epoch census for the whole requested interval, activation history,
  configuration changes and instrumentation gaps. Combining a partial census cannot make district E.
- Bind the confirmed membership to production sequences/census; approve clock precision, retry/evidence
  retention, loss taint and epoch/revocation history.
- Bounded durable identity/conflict tombstones and cross-cut correction/disclosure policy.
- Independent review of the qualified claim and source/provider platform evidence.

No heartbeat bridges missing instrumentation. No public DTO can label a logical-cut sample as
final activity totals. A future live as-of response would need the complete named vector of
stream cuts, count cut and validity horizon, plus the ordinary occurrence calendar. A common
wall-clock frontier would require a separate pending-commit barrier and proof. Keep S1 blocked
on those obligations; passing this finite model is evidence for the narrower hypothesis only.

## Validation of this slice

On the merged reporting baseline `a5164d7`, frozen install, lint/types/OpenAPI, 89 focused model
tests and all 818 tests across 58 files passed. The standalone rollback drill preserved 84 checks;
both Worker dry-run bundles and whitespace checks passed. The model has no runtime importer,
and no app, live contract, sink, lockfile, workflow or deployment configuration changed.
Canonical exact-head CI and revision-bound review are required after publication. These local
checks do not establish independent proof review, platform durability or production readiness.
