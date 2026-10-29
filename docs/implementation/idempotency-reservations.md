# Reservation ownership at evaluation completion (HM-20)

The evaluator now commits a result, receipt and telemetry only for the current owner of an
unexpired pending reservation. `begin()` returns an opaque random `reservationId` when it reserves
a key. `completeReserved()` and `abandonReserved()` must receive that exact token and request
digest. The token stays inside the Worker/DO boundary; it is neither a public request field nor
a telemetry/log dimension.

`completeReserved()` uses a conditional SQLite UPDATE with `RETURNING key` inside the existing
completion transaction. No matched row means no result, receipt, outbox or gap write. One matched
pending owner changes to done and clears the token; its receipt/telemetry then commit in the same
transaction. An injected write failure rolls back the ownership transition too. A simultaneous
second completion can never match the consumed owner. This count uses returned request rows;
the platform's `rowsWritten` includes index entries and cannot serve as a one-row predicate.

If the Worker loses its reservation while evaluating, it returns `409 idempotency_conflict` with
`retryable:true`, emits no completion metric and never returns the uncommitted decision as success.
A client can repeat the same request/key with a fresh service token to obtain the winning stored
result. The public SDK's existing automatic retry policy still excludes HTTP 409; callers handle
this conflict explicitly. A late failure's `abandonReserved()` cannot release a replacement owner.

## Reproduction and verification

Four probes against the previous implementation failed in the real SQLite DO harness: missing
and mismatched reservations still produced receipts; a second completion replaced the stored
result/created a second receipt; stale work abandoned a replacement reservation with the same
digest. These are reproduced failure modes, not evidence of a production incident.

The permanent tests cover those cases plus replacement with a different digest, expiry without
replacement, durable ownership after an instance abort, concurrent completion, additive migration,
retired RPC calls and the real overlapping HTTP handler path. In that last trace the first model
call is held, its reservation is expired, a second request commits, and the first returns a
conflict after release. A further HTTP retry replays the exact second result. The telemetry test
gives the rejected duplicate a distinct delivery; it adds neither an outbox row nor a gap.

Run `pnpm --dir apps/worker exec vitest run test/reservations.test.ts test/store.test.ts test/outbox.test.ts`.
The normal workspace suite and synthetic evaluator-to-receiver reconciliation also exercise the
updated request path. No production sequence, coverage claim, new analytics collection or retention
policy is enabled by this fix.

## Migration, version skew and rollback

The constructor adds nullable `reservation_id` to an old idempotency table. Existing completed
rows still replay. An existing pending row has no owner token and remains in progress until the
normal two-minute hold expires; no owner is invented for in-flight work. Its next reservation gets
a fresh token. Completed results and existing receipts/outbox data remain unchanged.

The new RPC names prevent argument-order confusion with the previous protocol. The retired
`complete()` throws a fixed content-free error before touching storage, so an old Worker calling
a newly deployed DO fails rather than ignoring a null and returning uncommitted success. Retired
`abandon()` has no effect. A new Worker calling an older DO lacks the new method and fails too.
This is fail-closed version skew, not a zero-downtime guarantee; keep the Worker and DO on the same
release and verify retries/readiness at the actual target.

Rolling back to code with the old unfenced completion method also restores its reproduced defect.
The nullable additive column itself is compatible with old reads/inserts, but a full rollback is
not proof that ownership protection survives. Prefer rolling forward; separately verify collection
disabled, pending work and product behavior under the approved operational rollback procedure.
Local instance abort and atomicity tests do not prove provider output-gate durability or detect
storage snapshot rollback. Those remain coverage-proof and production-acceptance obligations.
