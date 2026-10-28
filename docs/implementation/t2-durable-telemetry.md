# T2 — durable telemetry: outbox (W6) and exact receiver (W7)

**Status:** W6 (HM-20) implemented here; W7 (HM-21) follows in its own PR. Everything is **disabled by default**. Nothing in this change enrols a tenant, adds a `METRICS_COLLECTOR` binding, deploys a receiver or creates a dashboard. W8 (trusted local calendar, coverage, retention TTLs, queries) is **not** done: no usable historical chart exists, and missing coverage must never be shown as zero.

Related: [T1 runbook](t1-trusted-telemetry.md), [temporal analytics design](../design/temporal-analytics.md), [FERPA/COPPA](../privacy/ferpa-coppa.md).

## W6 — what changed

| Path | Role |
|---|---|
| `packages/telemetry-contracts` | v2 delivery envelope, v2 ack, producer/receiver enrolment parsers, shared constants |
| `packages/telemetry-sink` | v2 signing/verification (`hall-monitor-telemetry-v2`), ack MAC (`hall-monitor-telemetry-ack-v2`), `sendDeliveryV2` |
| `apps/worker/src/metrics.ts` | `prepareTelemetryDelivery`: projects the pair **before** completion |
| `apps/worker/src/store.ts` | outbox + coverage-gap tables, one alarm for cleanup and delivery |
| `apps/worker/src/app.ts` | passes the projection into `store.complete` |

### Protocol

v2 is a separate protocol, not an extension of v1: its own path (`/internal/v2/telemetry`), HMAC domains and strict schemas. A v1 signature never verifies as v2 (and vice versa), and a v1 `202 persisted:false` can never stand in for a v2 acknowledgment.

* **Envelope** `{ schemaVersion: 2, deliveryId, producerRevision, events }`. `deliveryId` is an opaque random `dlv_<32 hex>`, stable across retries and **not derived from any request, message, student, evaluation or case ID**. `producerRevision` is server-owned (from the tenant's v2 enrolment). Both exist **only** in this protected transport envelope; neither is part of a `TemporalMetricEvent` and neither may become an analytics dimension. `events` is exactly one `content_evaluated`, optionally followed by one matching `candidate_flagged` — an indivisible pair.
* **Ack** `{ schemaVersion: 2, status: "committed" | "deduplicated", deliveryId, digest, persisted: true, mac }`. The `mac` binds status, delivery ID and payload digest to the tenant key. A producer treats a response as an ack only if it parses strictly, matches **this** delivery ID and digest, and the MAC verifies. Everything else — outage, timeout, 4xx/5xx, T1's `202`, malformed, mismatched or forged acks — leaves the row in the outbox.
* **409** from the receiver means the delivery ID is held with a different digest; retrying cannot help, so the row becomes a `conflict` gap.

### Producer behaviour

1. After the evaluation succeeds and **before** `store.complete`, `prepareTelemetryDelivery` builds the content-free pair, freezes the occurrence timestamp once, assigns the delivery ID and producer revision, and computes the digest of the exact bytes.
2. `store.complete` writes the result, receipt **and** the outbox row (or, if the outbox is full, a coverage-gap count) in **one `transactionSync`**. A failed completion rolls all of it back; an idempotent replay or a failed evaluation never calls it, so neither adds a row.
3. The existing Durable Object alarm now serves the earliest of: record cleanup, outbox retry/expiry, gap expiry. It is never moved later by delivery work, and re-arms for the next retry rather than the next cleanup. Constructing the object re-arms it, so a row committed just before a crash is still delivered.
4. Delivery happens in the alarm, after commit and outside the response path. Failure backs off 30 s doubling to 15 min. Every retry re-signs the **same bytes** (same ID and digest) with a fresh transport timestamp. At most 10 deliveries are attempted per alarm; each attempt times out after 5 s.
5. Enrolment (`HM_TELEMETRY_V2_ENABLED`, tenant grant, source, grade bands) is re-read on **every** attempt. A disabled or revoked tenant sends nothing more, and its queued rows are dropped as `revoked` gaps rather than held.

### Bounds and coverage gaps

| Bound | Default | Setting |
|---|---|---|
| Outbox rows per tenant | 500 | `HM_TELEMETRY_OUTBOX_MAX_ROWS` (≤ 5000) |
| Outbox payload bytes per tenant | 1 MiB | `HM_TELEMETRY_OUTBOX_MAX_BYTES` (≤ 8 MiB) |
| Retry horizon after occurrence | 6 h | `HM_TELEMETRY_RETRY_HORIZON_SECONDS` (≤ 12 h) |
| Gap evidence retention | 30 days | constant `GAP_RETENTION_MS` — a placeholder pending W8's separately approved TTLs |

When a delivery cannot be kept (capacity), expires past its horizon, is revoked, conflicts, or could not even be built, the store records a **coarse, durable coverage gap**: one row per `(UTC occurrence hour, reason)` with a lost-delivery count. The table is bounded by hours retained × 5 reasons and holds no IDs, grade, source or content. Moderation is unaffected throughout. `telemetryState()` exposes pending/retrying counts and gaps so analytics can be marked incomplete; observation through saturation is **not** lossless and must not be reported as complete.

### Configuration (separate opt-in; v1 is untouched)

Producer, as Worker secrets (never in `wrangler.jsonc`, never defaulted):

* `HM_TELEMETRY_V2_ENABLED` — the exact string `true`.
* `HM_TELEMETRY_V2_TENANTS` — `{ "<tenant>": { "source", "gradeBands", "signingKey", "producerRevision" } }`. Strict: unknown fields invalidate the whole setting. A v1 `HM_TELEMETRY_TENANTS` grant does not enrol a tenant for v2, and a v2 grant does not enable v1.
* the existing optional `METRICS_COLLECTOR` service binding. **None is added by this change.**

`scripts/deploy-worker.mjs` now uploads these when set in the deploying environment, and validates the JSON.

### Privacy properties (tested)

* Outbox payloads contain no message text, request/idempotency/evaluation IDs, tenant ID, cost center or source surface.
* Logs carry only fixed event names and reason codes — never payloads, delivery IDs, keys, exception messages or identifiers.
* The signing key is read from enrolment at send time and is never written to the outbox, gaps or logs.
* v1 behaviour is unchanged: the validate-and-discard receiver still answers `202 … persisted:false`.

### Tests

* `apps/worker/test/outbox.test.ts` (Workers/DO persistence harness): atomic completion + commit-failure rollback, replay/failure add nothing, restart re-arms, immediate alarm-driven delivery, signed v2 request, timeout/rejection/lost-ack with same ID+digest and fresh signature, T1/invalid/mismatched/forged acks, partial batch failure, capacity and byte saturation gaps, expiry, disable/revocation on retry, conflict, shared alarm, log/storage leakage, unchanged moderation decisions.
* `packages/telemetry-contracts/__tests__/delivery-v2.test.ts`, `packages/telemetry-sink/__tests__/delivery-v2.test.ts`: strict schemas, indivisible pair, domain separation, stream bound, ack outcomes.

Test seams: `IdempotencyStore` exposes protected `producerGrants`, `collector`, `firstAttemptDelayMs`, `deliveryTimeoutMs` and `afterCompletionWrites` so `apps/worker/test/entry.ts` can inject a controllable collector and a commit failure. Production leaves them at their defaults.

## Limits and follow-ups

* Delivery needs a receiver that implements the v2 ack (W7). Until one is deployed and enrolled, an enabled tenant's rows retry until their horizon and become `expired` gaps — which is why nothing is enabled here.
* Backoff is deterministic (no jitter); acceptable at per-tenant volumes, revisit if a thundering herd appears.
* Gap retention and outbox TTLs are defaults, not approved retention. W8 owns the approved parameters.
