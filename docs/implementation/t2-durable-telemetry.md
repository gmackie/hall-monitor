# T2 — durable telemetry: outbox (W6) and exact receiver (W7)

**Status:** W6 (HM-20, PR #10), W7 (HM-21, PR #11) and W8a (HM-21: trusted time, correction revisions, retention) are implemented. Everything is **disabled by default**. Nothing here enrols a tenant, adds a `METRICS_COLLECTOR` binding, deploys the receiver, approves any retention or creates a dashboard. **W8b (authoritative producer coverage) and W9 (reporting) are not done**: no usable historical chart exists, and missing coverage must never be shown as zero. See [W8a](#w8a--trusted-time-correction-revisions-and-retention-hm-21).

Related: [T1 runbook](t1-trusted-telemetry.md), [temporal analytics design](../design/temporal-analytics.md), [FERPA/COPPA](../privacy/ferpa-coppa.md).

## W6 — what changed

| Path | Role |
|---|---|
| `packages/telemetry-contracts` | v2 delivery envelope, v2 ack, producer/receiver enrolment parsers, shared constants |
| `packages/telemetry-sink` | v2 signing/verification (`hall-monitor-telemetry-v2`), ack MAC (`hall-monitor-telemetry-ack-v2`), `sendDeliveryV2` |
| `apps/worker/src/metrics.ts` | `prepareTelemetryDelivery`: projects the pair **before** completion |
| `apps/worker/src/store.ts` | outbox + coverage-gap tables, one alarm for cleanup and delivery |
| `apps/worker/src/app.ts` | passes the projection and current reservation owner into `store.completeReserved` |

### Protocol

v2 is a separate protocol, not an extension of v1: its own path (`/internal/v2/telemetry`), HMAC domains and strict schemas. A v1 signature never verifies as v2 (and vice versa), and a v1 `202 persisted:false` can never stand in for a v2 acknowledgment.

* **Envelope** `{ schemaVersion: 2, deliveryId, producerRevision, events }`. `deliveryId` is an opaque random `dlv_<32 hex>`, stable across retries and **not derived from any request, message, student, evaluation or case ID**. `producerRevision` is server-owned (from the tenant's v2 enrolment). Both exist **only** in this protected transport envelope; neither is part of a `TemporalMetricEvent`. The opaque delivery ID is never an analytics dimension. The producer revision **is**, deliberately: but only as a server-approved, bounded value (W8a pins the approved list per tenant and effective interval, so a producer cannot introduce a new one). `events` is exactly one `content_evaluated`, optionally followed by one matching `candidate_flagged` — an indivisible pair.
* **Ack** `{ schemaVersion: 2, status: "committed" | "deduplicated", deliveryId, digest, persisted: true, mac }`. The `mac` binds status, delivery ID and payload digest to the tenant key. A producer treats a response as an ack only if it parses strictly, matches **this** delivery ID and digest, and the MAC verifies. Everything else — outage, timeout, 4xx/5xx, T1's `202`, malformed, mismatched or forged acks — leaves the row in the outbox.
* **409** from the receiver means the delivery ID is held with a different digest; retrying cannot help, so the row becomes a `conflict` gap.

### Producer behaviour

1. After the evaluation succeeds and **before** `store.completeReserved`, `prepareTelemetryDelivery` builds the content-free pair, freezes the occurrence timestamp once, assigns the delivery ID and producer revision, and computes the digest of the exact bytes.
2. `store.completeReserved` verifies the current unexpired pending reservation owner, then writes the result, receipt **and** the outbox row (or, if the outbox is full, a coverage-gap count) in **one `transactionSync`**. A failed completion rolls all of it back; an idempotent replay or a failed evaluation never calls it, so neither adds a row. Stale or duplicate owners write nothing and the Worker returns a retryable conflict; see [reservation ownership and migration](idempotency-reservations.md).
3. The existing Durable Object alarm now serves the earliest of: record cleanup, outbox retry/expiry, gap expiry. It is never moved later by delivery work, and re-arms for the next retry rather than the next cleanup. Constructing the object re-arms it, so a row committed just before a crash is still delivered.
4. Delivery happens in the alarm, after commit and outside the response path. Failure backs off 30 s doubling to 15 min. Every retry re-signs the **same bytes** (same ID and digest) with a fresh transport timestamp. At most 10 deliveries are attempted per alarm; each attempt times out after 5 s.
5. Enrolment (`HM_TELEMETRY_V2_ENABLED`, tenant grant, source, grade bands) is re-read on **every** attempt. A disabled or revoked tenant sends nothing more, and its queued rows are dropped as `revoked` gaps rather than held.

### Bounds and coverage gaps

| Bound | Default | Setting |
|---|---|---|
| Outbox rows per tenant | 500 | `HM_TELEMETRY_OUTBOX_MAX_ROWS` (≤ 5000) |
| Outbox payload bytes per tenant | 1 MiB | `HM_TELEMETRY_OUTBOX_MAX_BYTES` (≤ 8 MiB) |
| Retry horizon after occurrence | 6 h | `HM_TELEMETRY_RETRY_HORIZON_SECONDS` (≤ 12 h) |
| Gap evidence retention | none: set by the tenant's approved policy | `HM_TELEMETRY_V2_RETENTION` (`gapSeconds`); W8a removed the provisional 30-day constant |

When a delivery cannot be kept (capacity), expires past its horizon, is revoked, conflicts, or could not even be built, the store records a **coarse, durable coverage gap**: one row per `(UTC occurrence hour, reason)` with a lost-delivery count. The table is bounded by hours retained × 5 reasons and holds no IDs, grade, source or content. Moderation is unaffected throughout. `telemetryState()` exposes pending/retrying counts and gaps so analytics can be marked incomplete; observation through saturation is **not** lossless and must not be reported as complete.

### Configuration (separate opt-in; v1 is untouched)

Producer, as Worker secrets (never in `wrangler.jsonc`, never defaulted):

* `HM_TELEMETRY_V2_ENABLED` — the exact string `true`.
* `HM_TELEMETRY_V2_TENANTS` — `{ "<tenant>": { "source", "gradeBands", "signingKey", "producerRevision" } }`. Strict: unknown fields invalidate the whole setting. A v1 `HM_TELEMETRY_TENANTS` grant does not enrol a tenant for v2, and a v2 grant does not enable v1.
* `HM_TELEMETRY_V2_RETENTION` (W8a) — the tenant's operator-approved retention policy; **required**, see W8a below. Without a valid policy in force the producer collects nothing for that tenant.
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

* `deliveries`: a **domain-separated SHA-256** of `"hall-monitor-telemetry-delivery-key-v2\n" + tenant + "\n" + delivery ID` (never the raw ID; this is a plain hash of a random 128-bit ID, **not** a keyed HMAC), the body digest (for conflict detection) and an expiry measured from the end of the occurrence's bucket. Short-lived.
* `rollups`: counters per **exact 15-minute UTC occurrence bucket** × source × grade band × modality × producer revision (and, from W8a, the trusted configuration and calendar revision). 15 minutes is the finest unit shared by every real UTC offset (including `:30`/`:45`), so local hours derive exactly. This is **not** the prototype's date-free 168-tile grouping: different weeks and both fall-back hours stay distinct rows.
* `ingest_health`: trusted ingress time and committed/deduplicated/conflict counts, kept apart from occurrence buckets.
* (W8a) `retention_state`: the applied policy's revision and durations, and a revocation tombstone. No approval reference, tenant or delivery ID.

There is no per-message or per-event row, no raw delivery ID, no tenant or student identifier in a row, and the Worker has no logging path (`observability` is off and nothing calls `console`).

### Time windows (the dedupe-expiry rule)

An occurrence is accepted only if it is no more than **24 h** old (`TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS`) and no more than **5 min** in the receiver's future. The producer's retry horizon is capped at 12 h, well inside the 24 h. Dedupe state lives until the bucket end + 24 h + 5 min, i.e. at least the entire accepted horizon. The age check runs **before** the dedupe lookup, so after the state expires a re-signed old delivery is refused (`422 stale_occurrence`) rather than counted again. The alarm purges expired dedupe rows and goes idle when none remain.

### Limits and gates (not done here)

* **Retention, trusted time and corrections are W8a (below).** Producer enrolment, coverage and heartbeat, and the "missing is not zero" semantics for authoritative coverage are **W8b**. Do not enrol a real tenant until an operator-approved retention policy exists and W8b's coverage semantics are in place.
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
* Gap retention is now policy-driven (W8a). No retention duration has been approved by anyone; the values in tests are fictional.

## W8a — trusted time, correction revisions and retention (HM-21)

**Software slice only.** It does not complete HM-21, does not establish source completeness (W8b) or reporting (W9), approves no retention duration and enrols no tenant. The receiver stays internal, undeployed and disabled by default.

| Path | Role |
|---|---|
| `packages/telemetry-contracts/src/index.ts` | strict retention policy schema and validator, shared by producer and receiver |
| `apps/telemetry-worker/src/tenant-config.ts` | strict per-tenant trusted configuration (`HM_TELEMETRY_V2_CONFIG`) |
| `apps/telemetry-worker/src/time.ts` | interval resolution and local dimensions (reuses `localTimeBucket`) |
| `apps/telemetry-worker/src/retention.ts` | expiry arithmetic on the 15-minute grid |
| `apps/telemetry-worker/src/store.ts` | pinned dimensions, correction revisions, alarm-driven and read-time expiry, revocation, migration |
| `apps/worker/src/{metrics,store}.ts` | producer retention admission and policy-driven gap retention |

### Server-owned configuration

Receiver secret `HM_TELEMETRY_V2_CONFIG` (not in `wrangler.jsonc`, never defaulted), supplied by an authorized operator:

```json
{ "<tenant>": {
    "schemaVersion": 1,
    "configRevision": "<opaque, unique across tenants>",
    "source": "educateos",
    "state": "active",
    "retention": {
      "policyRevision": "<opaque>", "approvalRef": "<opaque reference supplied by the authorizing operator>",
      "effectiveFrom": "<UTC instant>", "approvedUntil": "<UTC instant>",
      "dedupeSeconds": "<n>", "rollupSeconds": "<n>", "healthSeconds": "<n>", "gapSeconds": "<n>"
    },
    "intervals": [ {
      "from": "<UTC, on a 15-minute boundary>", "to": "<UTC, on a 15-minute boundary>",
      "timeZone": "<IANA zone>", "calendarRevision": "<opaque, unique per tenant>",
      "producerRevisions": ["<approved>"],
      "calendar": [ { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "kind": "holiday" } ]
    } ]
} }
```

**There are no defaults and this document recommends no duration.** `state: "revoked"` additionally requires `revocationRef` (and nothing else allows that field). The setting is strict and bounded: unknown fields anywhere, an invalid zone or date, a boundary finer than a quarter hour (unsupported precision), overlapping intervals or calendar spans, a duplicate calendar/config revision, more than 16 intervals / 400 spans / 16 revisions, a source that differs from the tenant's grant, or an interval approving a producer revision the grant does not, invalidate the **whole** setting. Invalid or absent configuration means the route stores nothing for any tenant (`503 invalid_configuration`). Gaps between intervals are allowed in the setting but an occurrence inside one is refused (`422 unconfigured_occurrence`). Calendar dates are classified only by explicit spans; an unlisted date stays `unknown` (a weekend is never inferred from the weekday, so weekends are listed like any other span). Nothing a producer sends selects any of this: a signed delivery carrying a zone, calendar, revision or retention field is not a valid envelope.

The producer's `HM_TELEMETRY_V2_RETENTION` is `{ "<tenant>": { ...the same retention object... } }`, strict and per-tenant.

### Retention policy rules

The same validator runs on both sides. The policy must be internally consistent and cover the accepted horizon: `dedupeSeconds` ≥ 24 h + 5 min (the occurrence window plus skew), `rollupSeconds` ≥ `dedupeSeconds`, `gapSeconds` ≥ `rollupSeconds`, `healthSeconds` ≥ 1 h, each at most 10 years, and `approvedUntil > effectiveFrom`. Durations are rounded **up** to the 15-minute grid, so no stored expiry reveals a finer instant and none shortens a retention. A policy not in force at the object's clock (expired, not yet effective, invalid, missing or conflicting) admits nothing: `403 retention_unapproved`, and nothing at all is written (not counters, dedupe state, health or policy state). This fails closed for telemetry only; moderation is unaffected and v1 is not enabled.

An approval ending stops **admission**. Data already stored is deleted by its own TTL (the approved retention), not by the approval's end.

### Trusted chronological dimensions

At ingest the Worker resolves the interval effective for the **original occurrence** (not arrival) and pins its zone, calendar revision and approved producer revisions. Each bucket row stores local date, local hour, weekday, Monday week start, actual UTC offset, calendar kind, zone, and configuration and calendar revision, computed with `localTimeBucket` from the bucket's UTC start. Distinct configuration revisions are distinct rows; a revision id that would put different dimensions into an existing row is refused rather than merged. If a 15-minute bucket would straddle a local hour or offset change, or the zone cannot be converted exactly, the occurrence is refused (`422 unsupported_alignment`): quarter-hour alignment is an explicit limitation and a bucket is never split or rounded. Tests cover Detroit and Los Angeles spring (167 h) and fall (169 h) weeks with both repeated hours distinct; Phoenix and Honolulu (no DST); `:30` and `:45` zones; holiday, weekend and unknown; year rollover; and an effective-dated configuration change.

### Correction revisions

Each new committed delivery increments its bucket's `revision` in the same statement as the counters and the dedupe row, and `lateRevisions` when it arrives after the bucket closed. A duplicate, conflict, stale, future, unapproved, unconfigured or refused request changes neither. `provisional` is true until bucket end + 24 h + 5 min (a late delivery could still arrive). Evaluated and candidate counts live in one row, so numerator and denominator always share source, grade band, modality and revisions. `rollups()` and `health()` are internal reads for W9; there is still no route.

### Expiry, replay safety and revocation

* One alarm serves the earliest of every expiry (dedupe, rollups, health, tombstone) and is re-armed on construction; expired rows are also excluded from reads before the alarm fires.
* Dedupe state lives at least until the accepted horizon has passed (never below it, whatever a policy says) and rollups outlive dedupe state, so an expired rollup cannot be rebuilt by a re-signed old event: it is older than the horizon (`422 stale_occurrence`). A bucket whose rollup would already be expired is refused as well.
* A changed policy takes effect at once and only tightens: rows keep the smaller of their stored expiry and what the current policy allows. The tightened expiry is **written to the row** (dedupe rows, health, and rollups in both the current and the pre-W8a tables), not merely applied at read time, so a later, longer policy or a restart cannot bring back a deadline a shorter one already ended (long, short, long before the short deadline still ends at the short one). Shortening deletes what is no longer permitted; lengthening revives or prolongs nothing. A policy change reaches the object when the tenant next contacts the receiver.
* **Revocation** is `state: "revoked"` in the server configuration. On the next authenticated request from that tenant the Worker calls the object's `revoke()`, which deletes its rollups and health, records a bounded tombstone, and keeps dedupe digests until their normal expiry. The tombstone refuses every occurrence in a bucket starting before its boundary, which is the later of the revocation time rounded up to a 15-minute bucket and the end of the newest purged bucket (held deliveries and rollups, current or pre-W8a). The second term matters because an occurrence is accepted up to 5 minutes ahead of the clock, so a purged bucket can start after the revocation time. While revoked nothing is accepted. After re-enrolment a delivery for any purged bucket is refused as stale and is **never** acknowledged as durably counted, since its totals are gone (the producer then records a coverage gap); a genuinely new occurrence in a later bucket is counted from scratch. **Limit:** revocation is triggered by contact. With no further requests from the tenant, data is removed at its own TTL; there is no admin route or scheduled sweep that reads server settings.
* Deletion is a SQLite `DELETE` plus alarm. It does not erase provider-internal recovery copies; those were not inspected and no backup or deletion drill was run.
* **Export/backup:** there is no export, queue, R2/D1, WAE or Logpush binding and none was added (the dry-run gate in `scripts/deploy-telemetry-worker.mjs` still forbids them). Any later export must apply the same expiry and revocation filter.

### Pre-W8a state

The receiver was never deployed or enrolled, but the migration is still non-destructive. Dedupe state is untouched (it gains a nullable bucket-end column). Rollups written without trusted dimensions move to `rollups_legacy`: counts are kept but no zone, calendar, revision or completeness (`null` / `"unavailable"`; nothing is invented), they expire under the policy and are removed by revocation, and a ten-year ceiling bounds them when no policy exists. Pre-W8a health counters are reset.

### Producer: retention admission, gaps and queued rows

`prepareTelemetryDelivery` requires a valid policy in force for the tenant (`HM_TELEMETRY_V2_RETENTION`); otherwise it collects nothing, logs a fixed `telemetry.retention_inactive`, and the evaluation proceeds unchanged. It never enables v1, authorizes a tenant or records complete coverage. Result, receipt and outbox-or-gap remain one transaction and no request is made on the response path. Gap evidence is kept for `gapSeconds` from the end of its UTC occurrence hour (rounded up to the hour). The policy in force is stored in `telemetry_policy` (tenant, gap duration, approval end; no approval reference) so the alarm can enforce it without new contact, and the alarm wakes for the earlier of delivery work and the approval ending while rows are queued. If the policy later expires, is removed or becomes invalid, **every** queued row, due or not, is **dropped without any network attempt** as a counted `revoked` gap kept for the last admitted duration, in bounded batches of 100 per alarm (each batch is one transaction, so a row's gap and its removal are atomic and counted once; the object re-arms at once while rows remain and goes idle when the queue is empty, rather than re-arming for the elapsed approval end); a row queued before policies existed is dropped the same way with a 30-day ceiling. A shortened policy trims gap evidence at the next contact; without contact, gaps expire at their stored times.

### Coverage boundary

W8a gives truthful time and retention metadata only. `health().producerCoverage` and each rollup's `completeness` are always `"unavailable"`: a healthy receiver, an empty rollup or a missing bucket says nothing about whether the producer (or an upstream product) was observing. No bucket is created as a zero, and no receiver heartbeat purports to prove producer health. W8b owns durable authoritative producer evidence and zero/completeness semantics.

### Tests (W8a)

`apps/telemetry-worker/test/{time,tenant-config,time-retention}.test.ts`, `packages/telemetry-contracts/__tests__/retention-policy.test.ts` and the new producer block in `apps/worker/test/outbox.test.ts`. The receiver tests use the real route and the real SQLite Durable Object with a clock seam (`now()` and `armAlarm()` on the store, used only by `test/entry.ts`). Every approval reference, duration, zone choice and calendar in a test is fictional.

### Still open

Operator-approved retention durations and their legal/privacy approval; W8b; W9 and its suppression and differencing rules; a scheduled sweep or admin path for revocation without contact; inspection of platform recovery copies; production deployment and any real enrolment.
