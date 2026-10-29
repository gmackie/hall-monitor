# Synthetic evaluator-to-receiver reconciliation (HM-27 / W16)

Run `pnpm reconciliation-drill --out dist/reconciliation-drill.json` after a frozen install.
The record includes the commit, dirty-source flag and 14 outcomes (four failure/delivery traces
and ten evaluated-volume membership regressions); it never copies raw
test errors or input content. A missing, failed or skipped trace fails the command. These tests
also run in `pnpm test`, including canonical CI. For a focused run without an artifact use
`pnpm --dir apps/worker exec vitest run test/reconciliation.test.ts`.
The test Worker exports both production Durable Object classes through their existing test seams.
Its **test-only** Wrangler config supplies both SQLite bindings. No deployed Worker config, route,
grant, retention value or enrollment is changed. Both stores and both sides of the signed v2
transport are real; the classifier responses, collector outage, lost acknowledgments and receiver
clock offset are controlled fixtures. No successful durable acknowledgment is fabricated.

The independent source ledger is fixed before evaluating or inspecting delivered payloads:
one benign completion, one harassment candidate and one degraded classifier-outage completion.
Expected E=3/F=1 includes the degraded completion. The owner confirmed all-kind/degraded
committed membership on 29 October; see [evaluated volume](../implementation/evaluated-volume.md).
The added regressions exercise all four supported kinds with both healthy and degraded results,
replay/conflict/rejection exclusions, and a batch with an already committed item plus a failed
item. They preserve receiver coverage unavailable; membership alone proves no completeness.

The reconciliation trace proves:

1. A replay and a request for an unknown policy add no extra queued completion. No delivery runs
   on the evaluation response path.
2. Collector outage leaves all three committed rows pending. Reconstructing each real object
   over its existing SQLite state preserves the rows and re-arms needed alarms; then aborting
   both object instances forces the next requests to start fresh instances with storage kept.
3. Reverse-order delivery and two concurrent copies reach the actual receiver. Its clock is
   advanced beyond the occurrence bucket; corrections update that original bucket once. Both
   receiver acknowledgments are dropped and the producer keeps all three rows.
4. After another reconstruction, real signed deduplicated acknowledgments clear the queue.
   Receiver totals remain E=3/F=1. Every retry retains its original delivery ID, payload and digest.
5. Synthetic text and source-surface/request/idempotency identifiers are absent from all captured
   transport bodies, receiver tables and observed application logs. Synthetic text is absent
   from all producer tables; raw transport delivery IDs are absent from receiver tables.

Separate traces account for queue capacity, retry expiry and source withdrawal as durable counted
gaps with no send. Source collection disabled afterward still returns moderation decisions and
adds no outbox row. Read-time receiver expiry hides historical totals before its alarm cleanup;
re-signed stale deliveries cannot recreate them. Authenticated receiver revocation purges totals
and refuses a held row after re-enrollment; the producer cannot clear that row with a false durable
acknowledgment.

## Limits and production acceptance

Reconstruction and instance abort in the Workers harness check persisted SQLite state and alarm scheduling. They do
not simulate provider snapshot rollback, prove the platform's durability/output-gate contract or
perform a Cloudflare production failure drill. The pool currently falls back from the configured
2026-10 compatibility date to its supported 2026-03 date; deployment acceptance remains separate.

Every rollup and receiver health assertion preserves coverage **unavailable**. Known fixture E/F
does not establish production source completeness, finality, verified missing-bucket zero, a live
dashboard, suppression safety or real incident rates. Source gaps are still local producer evidence
and are not transmitted as an authoritative receiver coverage proof.

No network, provider receipt, cloud log/export sink, real tenant, staffed referral or human
approval is exercised. Cloud sentinel checks, authenticated deployed readiness/default-off
acceptance, receiver target deployment, approved retention/privacy policy, end-to-end product
integration, rollback and launch signatures remain open under HM-21/HM-24/HM-27. A merge or
evaluator liveness probe alone cannot complete those requirements.
