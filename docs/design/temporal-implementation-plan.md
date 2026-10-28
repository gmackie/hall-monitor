# Temporal Safety Intelligence — implementation blueprint and PR breakdown

**2026-10-28.** This is the deliverable that converts the research/design package into executable work. The offline `packages/temporal-analytics` reference module and its synthetic tests are implemented in the current branch; all live ingestion, incident correlation, case review, dashboards and on-call operations remain **future work**, with separate legal/privacy/human gates. Avoid treating this roadmap as permission to turn on student monitoring.

## Definition of done (long-term)

A participating district can explicitly enroll approved school-managed surfaces; deploy contract-verified, age-aware evaluation without unauthorized provider routing; get bounded, privacy-preserving classroom guidance; route safety incidents to qualified personnel; maintain a case-scoped, pseudonymous evidence graph with human adjudication/appeal; answer FERPA/COPPA record requests; see accurate hourly/weekly operations via Flightdeck without exposing private student communications; and prove via drills that urgent safety work is not dropped, silently deferred or “resolved” solely by AI.

**A feature is not complete until functional tests, privacy/security adversarial tests, operational sign-off, and legal/guardian/student notices are complete.** For urgent response, an actual human staffing and escalation agreement is required; code does not provide that service.

## 1. Existing code reuse and invariants

- `packages/contracts`: stable evaluation wire schemas and content-free results; **do not change to include student IDs or histories**.
- `packages/evaluators`: deterministic plugins for cheap content rules; retain no raw evidence in receipts.
- `packages/clef`: Clef questions and model escalation; thresholds are currently uncalibrated; student image moderation intentionally held.
- `packages/policy`: built-in student/educator floors and tighten-only overlays; keep urgent/support and fail-closed protections.
- `packages/core`: orchestration remains request-scoped and product-neutral.
- `apps/worker`: service JWT with anti-replay, tenant auth, idempotency store, content-free logging.
- `packages/costing`: provider-reported integer nanoUSD receipts, not Analytics Engine estimates.
- `packages/shadow-report` and `packages/test-fixtures`: synthetic bench, policy diff, rollback drills.
- **New in this branch:** `packages/temporal-analytics` (pure, offline, content-free) and comprehensive temporal LLDs.

The new system should be additive and opt-in. Avoid broadening existing public service scopes or embedding case/teacher UI in the evaluation Worker.

## 2. Workstreams and concrete PR sequence

| PR | Deliverables / suggested paths | Test and approval boundary |
|---|---|---|
| T0 — Complete in current draft | `packages/temporal-analytics/{src,__tests__}`, temporal design docs, synthetic DST/bucket/cost primitives | CI passes, no live student collection. |
| T1 — Trusted metrics adapter | `packages/telemetry-contracts`, `packages/telemetry-sink`, opt-in `apps/worker/src/metrics.ts` with binding + tenant allowlist, deployment preflight | Payload rejection, no cross-tenant data, zero hidden logs, no streaming student IDs |
| T2 — Exact time rollups | `apps/telemetry-worker` plus district-level ingestion health, expected coverage, late-event correction, duplicate source outbox | Late/reordered/replayed event drills; exact rollup separate from sampled WAE |
| T3 — Flightdeck integration | Service bindings to read-only reporting API, typed fixed queries, 168-cell UX, source/filter/version legend, privacy suppression | Small cohort and differencing attack tests, missing-v-zero tests, DST |
| T4 — Provider registry and privacy gate | Multi-provider compatible Nouls + data classification/age rules and ZDR config verifier with Cloudflare Gateway Logpush/cache checks | Block unapproved routes, preserve model uncertainty, calibration and FERPA/COPPA legal sign-off |
| T5 — Safety platform action contracts | `packages/safety-events`, source adapters in EducateOS/PlayTrek, trusted evidence references and outbox, action state machine | Signed authoritative facts, private mute excluded, malicious group mute/reports tested |
| T6 — Correlation and human case service | `packages/incident-engine`, `apps/safety-worker`, D1/R2 isolated case storage, purpose/TTL/legal holds, identity vault and Gatekeeper approvals | Human-reviewed evidence, false attribution, tenant isolation, FERPA multi-student export, no auto unmask |
| T7 — Nudges and protective UX | Product-owned accessible multilingual pre-send guidance, private contact protection, support/report path, reversible friction | Student/guardian/pedagogue review; prove help-seeking not discouraged |
| T8 — Staffing and outcome evaluation | Forecast/queue simulator, on-call coverage and alarms, transparent response commitments, signed safety pilot | Actual trained human coverage verified; review latency and real world welfare measured |
| T9 — Optional external evidence | Case-scoped student-submitted URLs/screenshots only; public-source research after separate approval | Off-campus speech, platform terms, security of media, evidentiary provenance and data rights |

Split T1–T3 into their own PRs rather than adding live telemetry to the current documentation/foundation draft without test review. Any T4–T9 implementation affecting real children remains disabled by default until the corresponding gate.

## 3. Code organization (proposed)

~~~text
packages/
  temporal-analytics/          # Implemented offline synthetic reference primitives
  telemetry-contracts/         # Proposed, strict no-PII transport event and query DTOs
  telemetry-sink/              # Proposed, local approved WAE / exact rollup adapter
  noul-registry/               # Proposed, versioned decisions, modalities, calibration
  safety-events/               # Proposed, signed school-managed action observations
  incident-engine/             # Proposed, evidence provenance and temporal hypotheses
  governance/                  # Proposed, age, provider, retention and data-class gate
apps/
  worker/                      # Existing request-scoped evaluator, add opt-in metric adapter only
  telemetry-worker/            # Proposed, district scoped aggregation and query API
  safety-worker/               # Proposed, restricted incident/case endpoints
  review-ui/                   # Proposed, safeguarding/records roles with separate login
docs/
  design/...                   # Research and detailed specs
  privacy/...                  # FERPA, COPPA, ZDR, external evidence
  launch/...                   # Human launch sign-off/rollback
~~~

Flightdeck itself remains a separate product/dashboard surface. Expose bounded aggregate HTTP/service binding or MCP tools, not a privileged raw SQL capability. Build integration PRs in Flightdeck after read-only API is available; similarly EducateOS/PlayTrek source adapters and nudge UI live in their own owning repos.

## 4. Operational and security roles

| Role | Can | Cannot |
|---|---|---|
| Student | See own allowed interaction, use personal privacy protections, report, appeal, request assistance | Expose another student, mass-vote someone muted |
| Teacher | See legitimate educational course activity, approved general class climate suggestions | Search private allegations, inspect pseudonym graph, approve their own reveal |
| Safeguarding reviewer | Review assigned limited cases, request protected evidence with purpose | Browse all school communications, auto disclose identities based on score |
| Second approver / records officer | Approve bounded identity disclosure, access/export, legal hold | Bypass independent review/leave invisible audit |
| District privacy/security admin | Approve retention and providers, audit routes, revoke access | Inspect student evidence absent role/purpose |
| Service principal (Hall Monitor) | Evaluate approved message under pinned policy, emit permitted content-free metric | Authorize discipline or resolve real IDs |
| Flightdeck | Query approved aggregates and SLOs | Read raw message/case/student identifiers |
| External model provider | Transient approved inference under eligible contract/config | Retain for own training or unexpected purposes |

All read/write privileges are purpose bound, tenant-scoped, auditable and time-limited where suitable. Avoid granting agents a generic “search student private messages” MCP function; implement specific scoped tools such as case-summary, disclosure-request, decision review, and retention/export, each requiring explicit human authority.

## 5. Trust and threat model

| Attack/failure | Mitigation design |
|---|---|
| Forged safety event asserts another student caused harm | Product server signs source facts; human reports are distinct allegations; verify membership/role and original state |
| Student report brigading | Group dependent sources; dedupe votes; judge evidence, not report count; safe help path remains |
| Model induced to reinterpret quoted text as a command | Signed Nouls, untrusted text isolation, restricted tools, no authority in model output |
| Teacher queries tiny cohort to discover private case | Minimum cohort sizes, query templates, complementary suppression, query budget and secondary case auth |
| Cross-district deanonymization via repeated aggregate filters | Opt-in separate benchmark, coarse bands, no identifiers, formal privacy review/differencing controls |
| Vendor retention/log change | ZDR/project/Gateway/Logpush/cache configuration gate with periodic drift detection; fail closed |
| Late/out-of-order messages corrupt peak-hour heatmap | Source occurrence clock + server ingress clock, late correction, DST offset storage |
| WAE sampling hides rare urgent case | Exact restricted urgent ledger; WAE only broad statistical estimates |
| Human queue outage overnight | Verified staffing and independent urgent notification/fallback, tested acknowledgment |
| Wrong entity attribution/rumor believed as fact | Reified assertions, separate evidence score and referent confidence, contradiction, review/appeal |
| Legal hold conflicts with automatic TTL | Preservation state overrides scheduled deletion with documented authority |
| Training data built from children's private chats | Prohibited by default; separate informed lawful approval and processor audit |
| User opts out of nudge or personally blocks peer | Does not become an abuse indicator or guilt label |
| Unapproved off-campus account monitoring | No general crawler; restricted submitted-evidence and case-scoped investigation only |

## 6. Detailed CI and launch test matrix

### Unit and property tests
- Fixed-field metric rejects names, message bodies, device IDs, handles and unexpected fields.
- IANA zone conversion including Detroit, Los Angeles, Phoenix, Anchorage, Honolulu and half-hour offset zones; DST fold/skip.
- Weekday indexing, school calendar exception, cross-midnight and year rollover.
- Denominator matching and no divide-by-zero; rate stays unavailable on missing coverage; WAE sampling weights.
- Cost arithmetic in integer nanoUSD, overflow checks and provider-reported usage uncertainty.
- Noul score probability calibration and unknown/unsupported image category handling.
- Causal graph idempotency, retraction, duplicate reports, evidence independence and correction.

### Integration/security tests
- Strict service JWT and tenant scopes, replay guard and idempotency.
- Signed event outbox, queue retry/DLQ, late arrival, model outage, database migration rollback and retention hold.
- No raw body in response, Analytics Engine blobs, Worker logs, Gateway/Logpush, error reporting, metrics, traces or Flightdeck exports.
- Under-13 content cannot reach a non-ZDR/contract-unapproved provider and no automated fallback occurs.
- Gatekeeper second-party approval required for discretionary identity reveal; urgent path independently audited.
- Parent/eligible student record access, multi-student redaction, correction and deletion.
- Staff/teacher access boundary and attacker-driven cohort overlap differencing.
- Safety emergency remains actionable when analytics/queue is down.
- Student image holdings remain closed until category/modality/band calibration is approved.

### Load and usability tests
- Synthetic million-message traffic with school calendar / weekday/hour variation, traffic bursts and report brigades.
- Queue 429/timeout, scalable tenant isolation and application memory limits; 99th percentile user-visible moderation latency.
- Qualified human acknowledgment simulation across weekends, school breaks and DST changes; capacity planner calibrated from measured arrivals.
- Accessibility, language and socio-cultural variation, legitimate student complaints/venting, victim self-disclosure and low-literacy inputs.
- Impact measurement: false blocks, false allegations, appeals, student help-seeking and chilled expression.

## 7. PR and deployment acceptance

Each PR requires reproducible tests, change log, accurate API/cost/schema versioning, optional feature off by default, manual approval for any new student data flow, and rollback/drift runbook.

A district pilot needs a signed protection impact assessment and exact approved student source/age bands; consent and notices; a staffed safeguarding pathway; provider DPAs and ZDR verification; model calibration by risk/grade/modality; human role, export and appeal tests; retention and legal hold rules; honest public service-level commitments. These are not automatically satisfied by unit CI.

## 8. Open design decisions with explicit owners

- **District privacy officer/counsel:** Which personal school-managed chats may be processed and what age-appropriate notice/authorization exists? Distinct rights for student, parent, school counselor and staff?
- **Safeguarding lead:** Who is actually available nights/weekends, response urgency and handoff, and how to prevent urgent backlog invisibility?
- **Security lead:** WAE's fixed three-month retention versus desired operational TTL; fallback to shorter-lived DO/D1 with deletion auditing.
- **Incident domain lead:** Case pseudonym scope, strict source-evidence admissibility and graph lifecycle.
- **Model evaluation lead:** Which Nouls/thresholds can safely trigger prompts/holds, with calibrated high-confidence negatives and language coverage?
- **Records officer:** FERPA inspection/redaction and correction workflows, student data retention law, preservation and state-specific deadlines.
- **Product designer:** Nudge UX must protect legitimate dissent, private mute/ignore, bystanders and student reports.
- **Analytics lead:** Which aggregated cross-district metrics can be legally/ethically compared, and what formal disclosure control is needed?

## 9. Deliverable traceability

| Requirement | Document or code |
|---|---|
| U.S. hourly/day evidence, caveats | [us-moderation-timing.md](us-moderation-timing.md) |
| Precise metric semantics and exposed clocks | [temporal-metrics.md](temporal-metrics.md) |
| Event flows, WAE/D1 architecture | [temporal-analytics.md](temporal-analytics.md) |
| APIs, errors, source ledger schema | [temporal-events-and-api.md](temporal-events-and-api.md) |
| Staffing and cost | [temporal-capacity-and-operations.md](temporal-capacity-and-operations.md), `packages/temporal-analytics` |
| Flightdeck screens/queries/access | [flightdeck-operations.md](flightdeck-operations.md) |
| Bullying graph, Nouls, nudges | [incident-graph.md](incident-graph.md), [semantic-registry.md](semantic-registry.md), [behavior-and-interventions.md](behavior-and-interventions.md) |
| FERPA/COPPA and rights | [ferpa-coppa.md](../privacy/ferpa-coppa.md) |
| ZDR and retention | [zero-data-retention.md](../privacy/zero-data-retention.md) |
| External evidence | [external-evidence.md](../privacy/external-evidence.md) |
| Pilot gates | [launch checklist](../launch/launch-checklist.md), [validation](../validation-and-rollout.md) |

**Remaining implementation is material**, not a one-line enablement. The offline package + architecture documents are an honest foundation for scoped follow-on work, not an end-to-end production system.
