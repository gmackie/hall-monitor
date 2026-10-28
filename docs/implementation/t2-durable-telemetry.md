# T2 — durable telemetry: outbox (W6) and exact receiver (W7)

**Status:** W6 (HM-20, PR #10) and W7 (HM-21) are implemented in separate stacked PRs. Everything is **disabled by default**. Nothing here enrols a tenant, adds a `METRICS_COLLECTOR` binding, deploys the receiver or creates a dashboard. W8 (trusted local calendar, coverage, retention TTLs, queries) is **not** done: no usable historical chart exists, and missing coverage must never be shown as zero.

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

## W7 — exact aggregate receiver (HM-21)

| Path | Role |
|---|---|
| `apps/telemetry-worker/src/index.ts` | protocol router: v1 validate-and-discard (unchanged) and the opt-in v2 route |
| `apps/telemetry-worker/src/store.ts` | `TelemetryAggregateStore`: one SQLite Durable Object per tenant |
| `apps/telemetry-worker/wrangler.jsonc` | the `AGGREGATES` DO binding and migration; still no route, no `workers.dev` |
| `scripts/deploy-telemetry-worker.mjs` | **dry-run only** bundle and posture gate (also in both CI workflows) |

### Route and enablement

`POST /internal/v2/telemetry` is a distinct route beside the unchanged `/internal/v1/telemetry`. It is off unless the secret `HM_TELEMETRY_V2_ACCEPT` is exactly `aggregate`, and it has its own grants in `HM_TELEMETRY_V2_TENANTS`: `{ "<tenant>": { "source", "gradeBands", "signingKey", "producerRevisions": [...] } }` (1–16 approved revisions). v1 and v2 settings never enable each other. Default mode is disabled, the Worker has `workers_dev: false`, no routes and no other binding.

Per request: authenticate under the v2 domain (streaming 16 KiB bound, ±300 s timestamp) → strict envelope that must be exactly an evaluation pair (so no incident, report, review, urgent or sensitive-category kind can pass, even if correctly signed) → tenant grant (source, grade band, approved producer revision) → one object call. Failures return fixed content-free codes; `401` is indistinguishable for bad signatures and bad shapes.

### Exactly-once counting

`TelemetryAggregateStore.ingest` runs one `transactionSync`: look up the protected dedupe key → same key + same digest returns `deduplicated`, same key + different digest returns `conflict` (HTTP 409, nothing changes) → otherwise insert the dedupe row and increment the bucket counters **once for the entire pair** (`evaluated` +1, `candidate` +1 only if the same delivery carried its candidate). A failure anywhere rolls back all of it. Only after that commit (or finding it already committed) does the Worker return the signed ack (`committed` / `deduplicated`); the object being unavailable yields `503` and no ack, so the producer keeps its outbox row. The Durable Object is single-threaded, so duplicate, reordered and concurrent deliveries converge on the same totals (tested).

### What is stored

* `deliveries`: SHA-256 of `tenant + delivery ID` (never the raw ID), the body digest (for conflict detection) and an expiry measured from the end of the occurrence's bucket. Short-lived.
* `rollups`: counters per **exact 15-minute UTC occurrence bucket** × source × grade band × modality × producer revision. 15 minutes is the finest unit shared by every real UTC offset (including `:30`/`:45`), so W8 can derive local hours exactly. This is **not** the prototype's date-free 168-tile grouping: different weeks and both fall-back hours stay distinct rows.
* `ingest_health`: trusted ingress time and committed/deduplicated/conflict counts, kept apart from occurrence buckets.

There is no per-message or per-event row, no raw delivery ID, no tenant or student identifier in a row, and the Worker has no logging path (`observability` is off and nothing calls `console`).

### Time windows (the dedupe-expiry rule)

An occurrence is accepted only if it is no more than **24 h** old (`TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS`) and no more than **5 min** in the receiver's future. The producer's retry horizon is capped at 12 h, well inside the 24 h. Dedupe state lives until the bucket end + 24 h + 5 min, i.e. at least the entire accepted horizon. The age check runs **before** the dedupe lookup, so after the state expires a re-signed old delivery is refused (`422 stale_occurrence`) rather than counted again. The alarm purges expired dedupe rows and goes idle when none remain.

### Limits and gates (not done here)

* **No retention for `rollups` yet.** Approved TTLs, DST/trusted-calendar derivation, producer enrolment/coverage/heartbeat, late-correction revisions and the "missing is not zero" semantics are **W8**. Do not enrol a real tenant before W8 sets and exercises retention.
* **No read path.** There is no query endpoint or dashboard (W9). `rollups()`/`health()` are internal object methods for tests and W8.
* **Throughput is unmeasured.** One object per tenant is the first design. If measured per-tenant volume approaches a single object's budget, shard by bucket with unchanged idempotency semantics (do not add queues/WAE by default).
* **15-minute buckets are fine-grained** for small cohorts. Suppression, complementary suppression and differencing limits are W9's job, and are required before any read exposure.
* `HM_TELEMETRY_MAX_DEDUPE_ROWS` (default 50 000 per tenant) bounds dedupe state; at capacity new deliveries get `503 capacity` and no ack, so producers hold them and eventually record a gap.
* Nothing is deployed or enrolled by this work. `scripts/deploy-telemetry-worker.mjs` refuses anything but `--dry-run`.

### Tests

`apps/telemetry-worker/test/aggregate.test.ts` runs in the Workers pool against the real object: default-off and v1 independence, authentication and domain separation, per-tenant source/grade/revision restriction, refusal of non-pair kinds when correctly signed, streaming bound, whole-pair counting, stable duplicate ack, duplicate/reordered/concurrent convergence, same-ID/different-digest conflict (including concurrent), atomic rollback of the dedupe row and the whole pair, no ack when the object fails, dedupe capacity, occurrence window, full-horizon dedupe, re-signed replay after expiry (state present, expired, purged), alarm re-arm after restart, exact bucketing (week apart, 15-minute edges, DST fold, release identity) and storage/log leakage. The existing v1 tests run unchanged in the same pool.

## Limits and follow-ups

* Delivery needs the W7 receiver deployed and enrolled. Until then an enabled producer tenant's rows retry until their horizon and become `expired` gaps — which is why nothing is enabled here.
* Backoff is deterministic (no jitter); acceptable at per-tenant volumes, revisit if a thundering herd appears.
* Gap retention and outbox TTLs are defaults, not approved retention. W8 owns the approved parameters.
