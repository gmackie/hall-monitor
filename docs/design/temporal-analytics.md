# Temporal Safety Analytics — system design and low-level architecture

**Status:** implementation-ready LLD and experimental offline primitives, **not deployed collection, live dashboards, incident graph, or 24/7 human service.** Read alongside [the source-evidence memo](us-moderation-timing.md), [metric catalog](temporal-metrics.md), [event contracts](temporal-events-and-api.md), [Flightdeck views](flightdeck-operations.md), [operations models](temporal-capacity-and-operations.md) and [privacy](../privacy/zero-data-retention.md).

## 0. Executive design decision

Hall Monitor's existing content-evaluation Worker remains narrow, with content-free receipts and no student identity graph. Build **two separate planes**:

1. **Safety/case plane (exact, high confidentiality):** authorized school-managed events, human-submitted reports, urgent threat workflows, source evidence references, case-scoped hypotheses, strict identity access, legal retention. Designed in [incident-graph.md](incident-graph.md), not implemented.
2. **Observability/analytics plane (aggregated, no content or identities):** high-volume hourly and weekday event counts, classifier routing, cost, queue workload, intervention effectiveness and staffing performance. Designed here; only an offline pure TypeScript package is implemented under `packages/temporal-analytics`.

**Do not route case content to Flightdeck or store it in Workers Analytics Engine.** Flightdeck should be able to answer “Is our service responsive?” without being able to answer “What did a particular student say?”

## 1. Service topology

~~~mermaid
flowchart TD
  U[EducateOS or PlayTrek authorized surface] --> E[Hall Monitor existing /v1/evaluations]
  U --> O[Future scoped source outbox]
  E --> N[Content-free evaluation result / receipt]
  N --> M[Approved, optional metrics adapter]
  O --> I[Separate safety event ingress]
  I --> Q[Queues, validated and tenant scoped]
  Q --> C[Incident correlation service / DO]
  C --> X[Restricted D1/R2 evidence and case storage]
  X --> G[Gatekeeper authorization / district safeguarding]
  M --> A[District-scoped time aggregates / WAE]
  I -. "Only approved non-content lifecycle metrics" .-> A
  A --> F[Flightdeck aggregate dashboards]
  X -. "De-identified reviewed case outcomes only after authorized aggregation" .-> A
~~~

Dataflow prohibitions:
- No user text, embeddings, images, account name, school roster, exact student ID or case ID in the analytics event.
- No copies of raw chat in general-purpose analytics, support tools, cost receipts or a global U.S. dataset.
- No implicit coupling between incident graph state and student behavioral “reputation” scores.
- No automatic external provider fallback; a district's Governance Gate must approve every actual model route.
- No student-specific identity resolution or corrective disciplinary action from a dashboard metric.

## 2. Source of truth and immutable moments

At least eight event **kinds** matter:

| Kind | Authoritative producer | Clock semantics | Count unit |
|---|---|---|---|
| `content_evaluated` | Existing Hall Monitor after completion | Time of evaluation (not message creation) | One eligible evaluated submission |
| `candidate_flagged` | Evaluation adapter | Time candidate decision generated | Max one per evaluated submission (multiple categories live in restricted classifier results) |
| `report_received` | Product report intake | Actual accepted report time | One accepted report; copy/brigade status is separate |
| `incident_opened` | Future case engine | First case creation time | One incident candidate |
| `review_queued` | Human review service | Queue admission | One review job |
| `review_completed` | Human review service | Human resolution time | One completed review job |
| `protective_action` | Product safety action service | Time protection went into effect | One authorized protective action |
| `incident_resolved` | Authorized case reviewer | Case resolved time | One case |

Store **creation**, **classification**, **report**, **case-open**, **queue-enter**, **acknowledgment**, **action** and **resolution** timestamps separately in the protected source ledgers where they apply. A first actionable signal is a *reviewed interpretation*, not always the first ambiguous flag. Avoid retroactively rewriting events; store corrections with provenance and recompute aggregates where lawfully authorized.

The shipped `TemporalMetricEvent` prototype uses `occurredAt` as the kind-specific time. Its event set is fixed; exact case transition data belongs to a different future schema. A separate field for `ingestedAt` is maintained by the ingress service, not supplied as user payload.

## 3. Concurrency, reliability and idempotency

Proposed future ingress:
- Authenticate service principal with tenant-scoped issuer and audience, separate token permissions for `metrics:write` versus `safety-events:write`; never reuse user-supplied tenant identifiers for authorization.
- Transactional source outbox creates an event **once per business transition**; a stable opaque event ID is visible only to the source/ingress deduplicator, never ordinary Flightdeck. Publish after commit.
- Queue delivery may be at least once, delayed or reordered. Consumer deduplicates by (tenant, producer, event ID), applying append/upsert within a transaction to an exact restricted transition ledger.
- Per-case DO routes by keyed scoped case token and updates only with causal-version checks; no shared full-district student graph.
- Events arriving after the allowed watermark are not silently dropped; emit a correction to exact daily rollups and preserve a data-quality record. Analytics Engine's sampled rows are **not** an exact deduplication ledger.
- During a queue outage the source's outbox retries with bounded backoff and dead-letter policy; urgent safeguarding cannot depend solely on a delayed queue. Direct urgent human response is an independent, tested path.
- Analytics unavailability must not change the outcome of student safety evaluation. Do not fail student chat solely because Flightdeck or WAE is down.

Suggested availability objectives are **future district-approved targets**, not current SLOs: evaluation p95 from measured workload; metric ingestion best-effort with replay; safeguarding escalation with appropriate trained coverage; no SLA implied by a functioning Worker.

## 4. Time semantics, DST and district calendars

Every source event carries **UTC instant**. District configuration pins an IANA time zone, such as `America/Detroit`; do not infer location from a student IP, personal device GPS or public activity. A canonical school calendar provides `instructional`, `weekend`, `holiday`, `break`, `non_instructional` or `unknown`; do not assume every Monday is instructional.

Store enough to audit **two independent clocks**:
- `occurredAtUTC` (the actual stage event instant)
- `receivedAtUTC` (ingress/processing instant)
- derived `localDate`, `weekday` (Monday=0), `hour`, `utcOffsetMinutes`, `weekStartingMonday`, time-zone revision.

Analytics heatmaps can expose **168 local hour-of-week display cells**, but calendar weeks contain 167 or 169 elapsed hours at U.S. DST transitions. On fall-back, the two local 1 AM hours have different offsets and must remain separate for exact chronological storage even though they share a 168-cell heatmap tile. During spring-forward, 2 AM may be absent.

Timestamp source matters more than plotting: a Friday-night message, Saturday report and Monday review must appear in three different event series, never as one “Monday incident”. Calculate `timeToProtection` from the defensible first-actionable-signal timestamp to protective action, with qualifiers for right-censoring and data quality.

Do not confuse “zero events” with “no collection.” Maintain a separate uptime, calendar and eligible-hour **coverage table**, plus denominators for rates. If ingestion fails during 2–3 AM, heatmap cells become “missing coverage,” not zero.

## 5. Physical Cloudflare plan

| Component | Data permitted | Why |
|---|---|---|
| Existing Worker + Clef | Transient approved text/images and content-free response | Preserve existing API, profiles, receipts, cost budget |
| Future service-binding adapter | Fixed, content-free metric event | Instrument after outcome, feature-gated by an approved district |
| Workers Analytics Engine | District-scoped, content-free count dimensions; no event/case/student IDs | High-throughput approximate trend queries, not legal ledger |
| Queues | Authenticated event envelope with short-lived scoped references only | Decouple transitions, retry and absorb bursts |
| Durable Objects | Strictly scoped active case state or stream dedupe | Ordered per-case transitions and short-lived state |
| D1 | Exact incident metadata, reviewer actions and legally controlled access | Durable, queryable case ledger |
| R2 | Restricted evidence only when justified, encrypted/segmented | Retention, redaction, preservation, export |
| Flightdeck | Privacy-reviewed aggregates, no raw case evidence | Hour/week dashboards and staffing signals |
| Gatekeeper / Nathan | Authorized identity map, purpose-bound reviewer access, two-party approval where required | Policy, not AI, controls disclosure |

WAE writes are non-blocking and are designed for aggregate queries. Its `timestamp` is **write time**, so event-time analytics must use trusted source-derived local/UTC bucket fields, not blindly group on `timestamp` when messages arrive late. For approximate counts, use `SUM(_sample_interval)` instead of `COUNT()`; sampled data cannot reconstruct precise individual records. [WAE documentation](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

### Proposed WAE column layout (not enabled yet)

- `index1`: tenant-scoped, non-student aggregation key; **never** message ID, student ID, case ID, conversation ID, or unique per-event UUID.
- `blob1`: schema release code.
- `blob2`: approved product/source enum.
- `blob3`: event-kind enum.
- `blob4`: grade-band enum (privacy-approved local aggregation only).
- `blob5`: local calendar-kind enum.
- `blob6`: local weekday 0–6 as enum string.
- `blob7`: local hour 00–23 as enum string.
- `blob8`: category family enum where sufficiently coarse.
- `blob9`: urgency enum.
- `blob10`: modality enum.
- `double1`: event count 1 or a validated pre-aggregated count.
- `double2`: permitted stage duration milliseconds (if applicable).
- `double3`: approved non-content inference cost in integer-like units where precision permits; the exact cost ledger remains in Hall Monitor.
- **Never** use arbitrary context labels for WAE dimensions. WAE currently retains rows for **three months** (per its published [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)); there is no asserted per-row short TTL. If a district mandates shorter retention, choose a different district-controlled store/rollup with tested deletion, or do not write the sensitive cohort there.

Because a sampled analytic row may represent many source events, weighted totals are approximate for statistical purposes; ordinary WAE should not serve evidence export, billing adjudication, emergency dispatch or legal records.

## 6. Frontend/query security

The Flightdeck frontend may request only server-approved queries and **predefined aggregate dimensions**. Do not expose a raw query console for school staff. Enforce tenant identity and purpose server-side. Apply privacy thresholds over meaningful population/exposure and complementary suppression, prevent overlap differencing and query repetition; source count suppression alone is not anonymity. Cross-district aggregation requires separate consent, shared purpose, stronger privacy controls and documented review.

No school-facing national heatmap is provided just by deploying this package. External research distributions are not a safe prior for rating an individual student or ranking schools.

## 7. Causality and policy experimentation

Policy revision, classifier model version and AI routing changes can change flag volume independently of harmful events. Maintain approved versions in a **separate release/config dimension table**; compare matched traffic and calibrated labels, not simply raw flags before/after a deploy. Policy rollouts must use Flagship-like controlled exposure only after ethical review for real students. Synthetic shadow replay and retrospective counterfactual analysis are safer initial tools.

The protected incident engine may group repeated signals for review, but a count threshold **never automatically reveals identities or triggers discipline**. Genuine urgent safeguarding bypasses normal aggregation.

## 8. Implementation boundary and gates

As of this PR: the new pure `packages/temporal-analytics` package provides runtime fixed-field validation, institution-local bucketing, offline 168-cell aggregation, sampled-count weighting, suppression illustration, and scenario cost/base-rate math; it does **not** connect to Worker, WAE, Queues, Flightdeck or a human queue. See [implementation breakdown](temporal-implementation-plan.md) for concrete production work requiring test evidence and district approval.
