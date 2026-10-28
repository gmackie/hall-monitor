# Temporal safety telemetry, case event API and exact ledger — detailed contracts

**Design only:** nothing here creates endpoints on the current Hall Monitor Worker. Preserve existing `/v1/evaluations` wire schema, content-free receipts and API stability. The offline `packages/temporal-analytics` module is the **only** implemented piece of this temporal design.

## 1. Separate services, separate data classifications

| Plane | Producer/consumer | Allowed identifiers | Storage/retention |
|---|---|---|---|
| Content evaluation (existing) | Product → Hall Monitor Worker | Existing authenticated tenant, opaque evaluation ID | Content-free receipt/idempotency only; raw text/image processed transiently |
| Operational metrics (new) | Approved product / Worker adapter → district rollup | No student, message, incident or conversation identifiers in analytic event; tenant only from authenticated channel | District-local aggregations / sampled WAE; configurable short-lived operational retention |
| Safety observations (new) | Disclosed school-managed product → case ingress | Scoped pseudonymous actor/subject references, causal event key and evidence pointer | Restricted tenant-owned case/event store; purpose-specific TTL |
| Protected evidence (new) | Authorized report/investigator → sealed evidence service | Case ID, source reference, selected content where justified | Encrypted district-owned storage with legal holds and FERPA controls |
| Disclosures (new) | Approved safeguarding officer → Gatekeeper/identity vault | Case-scoped principal resolution | Independent, tamper-evident authorization/disclosure log |
| Flightdeck aggregates (new) | District rollup → dashboard | Sufficiently aggregated counts and fixed dimensions only | Role-limited analytics; no arbitrary SQL or student-linkable drilldown |

The existing Wire `EvaluationRequest` carries no conversation history except a count. **Don't modify it to contain the graph**; incident intelligence uses separate scopes and APIs and should be fully absent for tenants that have not approved it.

## 2. Recommended service boundaries and endpoints

### Existing and unchanged

- `POST /v1/evaluations`, `POST /v1/evaluations:batch`, `GET /v1/capabilities`, `GET /v1/receipts/{evaluationId}`: current behavior and response contracts unchanged.

### Proposed separate safety-events service (NOT BUILT)

| Route | Scope | Operation |
|---|---|---|
| `POST /v1/safety-events:batch` | `safety-events:write` | Verified school-managed action observations, 1..100 bounded events |
| `POST /v1/safety-reports` | `safety-reports:create` | Student/staff-supported reporting, independent help-seeking route |
| `GET /v1/incidents/{id}` | `incidents:read-summary` | Safe case summary; sensitive source excerpts require separate permission |
| `POST /v1/incidents/{id}/review` | `incidents:adjudicate` | Human hypothesis review, correction/retraction and disposition |
| `POST /v1/incidents/{id}/disclosure-requests` | `identity:request` | Record concrete purpose and minimum requested identities |
| `POST /v1/disclosure-requests/{id}/approve` | `identity:approve` | Independent authorized approver, not same requester |
| `POST /v1/disclosure-requests/{id}/resolve` | `identity:resolve` | Time-limited, scope-limited identity resolution after approval |
| `POST /v1/incidents/{id}/retention-hold` | `records:hold` | Authorized legal/FERPA hold independent of regular TTL |
| `POST /v1/incidents/{id}/access-export` | `records:export` | FERPA/COPPA supervised export/redaction workflow |
| `POST /v1/incidents/{id}/appeal` | `incidents:appeal` | Correction/review; cannot silently delete original adjudication |

All endpoints require short-lived service/user authorization and verified tenant/school scope. Approval permission is not granted solely because a user is a classroom teacher. Protect emergency bypass with purpose, contemporaneous documentation, limited scope, and independent post-incident review.

### Proposed operational analytics endpoints (NOT BUILT)

| Route | Scope | Operation |
|---|---|---|
| `POST /v1/telemetry:batch` | `telemetry:write` | Only fixed-field, content-free, approved producer metrics; no PII |
| `GET /v1/analytics/hour-of-week` | `analytics:read` | Predefined aggregate metric/query; local-zone/cohort/period and coverage status |
| `GET /v1/analytics/review-queue` | `analytics:read-ops` | Aggregate review operations, without evidence details |
| `GET /v1/analytics/model-costs` | `analytics:read-ops` | Non-content cost and model-routing statistics |
| `GET /v1/analytics/benchmarks` | `analytics:benchmark` | Separate **opted-in, privacy reviewed** cross-district aggregate data |

Require minimum aggregation/cohort windows and a query budget. A sequence of overlapping date filters or small group filters can reveal a student even when each response individually exceeds a naive count threshold; the server must detect/restrict that.

## 3. Fixed operational schema

Prototyped in `packages/temporal-analytics/src/events.ts`:

~~~json
{
  "schemaVersion": 1,
  "occurredAt": "2026-10-28T14:00:00Z",
  "kind": "candidate_flagged",
  "category": "harassment",
  "priority": "routine",
  "modality": "text",
  "gradeBand": "g9_12",
  "source": "educateos",
  "calendarKind": "instructional"
}
~~~

All categories, priorities, modalities, grades, sources and calendar kinds must be fixed enumerations. No source metadata object, arbitrary labels, student reference, free text, source URLs, device IDs or other fields accepted. Validate at the trusted district-controlled source and again at intake. Don't let an untrusted client choose the grade band or instructional calendar.

One event is not enough to deduplicate a network retry; a trusted outbox uses a separate idempotency ID in a **protected transport envelope**, strips it before the metrics transform and stores dedup in district-local exact ledger. The prototype is an offline calculation primitive, not a network ingestion protocol.

### Trustworthy timestamps

- `occurredAt` must be event-time UTC instant with Z.
- Ingress stamps `receivedAt` with server clock; reports excessive skew or missing/late events to operator telemetry.
- Institution's IANA timezone and calendar revision are separately pinned server-side.
- For a school-group permission action, the *source product* supplies the action timestamp and signed state transition; the model cannot invent it.
- For human review, queue admission, first qualified acknowledgment and completion are separately audited; not the time the model saw a prompt.

## 4. Proposed protected safety action schema

Example **restricted**, not legal source of truth without verification:

~~~json
{
  "schemaVersion": "school-safety-events/1",
  "tenantEventId": "evt_08Q7",
  "producer": "educateos",
  "occurredAt": "2026-10-28T18:14:00Z",
  "kind": "group.member_removed",
  "actorScopedRef": "p_7n2",
  "affectedScopedRefs": ["p_4x9"],
  "conversationScopedRef": "g_sci_8",
  "context": {
    "activityPurpose": "required_group_work",
    "authority": "delegated_student_moderator"
  },
  "evidenceRef": "source://approved-evidence-ref"
}
~~~

The source MUST sign/attest observed identity, role, enrollment, school purpose and actual permission transition. Such references can still be FERPA-protected student data. The service rejects a client-submitted “someone is bully” object as a platform-observed fact; it may accept that as a *student report*, clearly marked as allegation.

Out-of-order event handling: store timestamp plus source aggregate version; if a removal is later reversed, create a new `group.member_restored` observation, not overwrite history. Source idempotency must survive retries/worker restarts. A monotonic version per case or conversation prevents stale permission events from overwriting new state.

## 5. Exact restricted case schema

Relational shape (proposed D1; not migrations yet):

~~~sql
CREATE TABLE incidents (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  case_status TEXT NOT NULL CHECK(case_status IN
    ('candidate','review_required','under_review','closed_unsubstantiated','substantiated')),
  purpose TEXT NOT NULL DEFAULT 'student_safety',
  first_actionable_at_utc TEXT,
  opened_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT,
  reviewer_policy_version TEXT NOT NULL,
  retention_rule_id TEXT NOT NULL,
  legal_hold INTEGER NOT NULL DEFAULT 0,
  row_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,incident_id)
);

CREATE TABLE incident_assertions (
  tenant_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  assertion_kind TEXT NOT NULL,
  provenance_ref TEXT NOT NULL,
  model_revision TEXT,
  calibration_revision TEXT,
  probability REAL,
  status TEXT NOT NULL CHECK(status IN
    ('unreviewed','verified','retracted','expired')),
  expires_at_utc TEXT NOT NULL,
  PRIMARY KEY(tenant_id,assertion_id),
  FOREIGN KEY(tenant_id,incident_id)
    REFERENCES incidents(tenant_id,incident_id)
);

CREATE TABLE incident_actions (
  tenant_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action_at_utc TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  PRIMARY KEY(tenant_id,action_id),
  FOREIGN KEY(tenant_id,incident_id)
    REFERENCES incidents(tenant_id,incident_id)
);

CREATE TABLE source_event_dedupe (
  tenant_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  accepted_at_utc TEXT NOT NULL,
  PRIMARY KEY(tenant_id,producer,event_id)
);
~~~

SQLite/D1 has **no implicit tenant row-level security**: repositories must enforce the tenant in every query, with security tests and ideally district account/database separation. Foreign key enforcement/migrations need explicit verification. None of the above schema alone provides a secure identity vault. Sensitive evidence bytes should be held in protected R2 with separate keys, access logs, encryption and lifecycle policy.

Don't automatically store a speculative claim about every student's reputation; case assertions require genuine, reviewable safety purpose, expiry and counterevidence.

## 6. Sample transport error and idempotency policy

- Invalid tenant/scope/signature: 401/403, do not echo content.
- Malformed schema/forbidden field: 400 with fixed reason code, do not quote body.
- Repeated event ID with same keyed digest: 200 accepted-already (no duplicate actions).
- Repeated event ID with different digest: 409 idempotency conflict and security alert.
- Over quota: 429 with Retry-After, but urgent safeguarding uses independently staffed/protected path.
- Unknown retention/provider authorization: reject transfer before model call; don't degrade into unapproved provider.
- Downstream unavailable: outbox retry, bounded DLQ, notify owner; do not lose urgent alerts or falsely mark incident completed.
- Unapproved real-student event source: 403/503 fail closed with non-content audit, not silent enablement.

Exact message evidence, redaction and human-review decisions must have independent access and audit, not a raw “view source” hyperlink for ordinary teachers.

## 7. Security tests and completion conditions

- Unauthorized teacher cannot read named case, victim identity, source text, moderation-history detail or external link.
- Replay, cross-tenant references, forged roles, direct D1 IDOR and manipulated permission events rejected.
- Nudge delivery uses a one-time scoped token without exposing other private conversations or reports.
- Student personal mute/block events never become an ordinary gossip/harassment graph signal.
- Correct handling of late/duplicate/out-of-order events, changed policy revisions, DST, denied provider route, storage expiry and legal hold.
- No human disciplinary action is possible from model confidence alone.
- Parent/eligible-student inspection, multi-student redaction, appeal and retention holds are tested against district policy.
- Telemetry pipeline rejects identifiers, message bodies, arbitrary context labels or cohort/time slices below approved privacy thresholds.

See [temporal implementation plan](temporal-implementation-plan.md) and [incident graph](incident-graph.md).
