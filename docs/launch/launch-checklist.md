# Hall Monitor launch checklist (template)

Copy this file per rollout stage (for example `launch-<deployment>-<stage>-<date>.md`), fill in
every row with **actual data**, and have the named owners sign. It implements the M7 gates of the
SchoolOS / Hall Monitor plan: safety, privacy, economics, reliability, performance and governance.

Rollout stages, in order; each stage needs its own signed copy:

1. Synthetic shadow mode (no real users; `pnpm shadow-report`, shadow tenants).
2. Consenting educator-only content mode.
3. Small opt-in staff beta.
4. Optional grades 6-12 supervised pilot, only after legal, privacy and security review.

A failure in a **privacy** or **safeguarding** item blocks student rollout (stage 4); it does not
block educator-only local planning (stages 1-2). Children are never unconsented safety-evaluation
training data, and shadow mode must not collect raw student data: Hall Monitor stores no content,
and a student-facing profile with required moderation is never shadowed unless the tenant is
configured with `allowStudentShadow`, which is reserved for synthetic or staff-only traffic.

For additional proposed student-safety features, also review the
[architecture and privacy design package](../design/README.md), the
[zero-retention controls](../privacy/zero-data-retention.md), and the
[deployment milestones](../validation-and-rollout.md). These new checklist rows do not imply
their features are implemented.

## How to fill it in

- **Evidence**: a link or path to the artifact (report JSON, drill record, PR, signed document),
  never pasted content. Reports from `pnpm shadow-report` are content-free unless generated with
  `--include-text`, which is for synthetic data only.
- **Owner**: a named person (role in brackets). An agent may prepare evidence but never owns a row.
- **Status**: `open`, `pass`, `fail`, `waived (by whom, why, until when)`.
- **Who**: `agent` rows can be produced by automation from this repository; `human` rows need a
  person's judgement, authority or signature and **cannot be completed by an agent**. Marked
  "human only" below.

Stage: `__________`  Deployment / account: `__________`  Hall Monitor commit or release: `__________`
Policy revisions pinned: `__________`  Resolver: `__________`  Evaluator bundle: `__________`

## 1. Safety

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| S1 | Shadow report over the frozen synthetic corpus for every profile in scope (`pnpm shadow-report --profile <id> --out ...`), with no mismatch on a case not marked `requiresClassifier` | | | open | agent |
| S2 | Representative benign, literary, academic, mental-health and adversarial fixtures reviewed for coverage of this deployment's subjects, grade bands and languages | | | open | human only |
| S3 | Human-reviewed false-positive / false-negative calibration per risk class and grade band; Clef thresholds replaced (`UNCALIBRATED_THRESHOLDS` must not ship to students) | | | open | human only |
| S4 | Blocking thresholds per risk class written down and approved | | | open | human only |
| S5 | Distress disclosures route to `support` in every profile and language in scope, including during classifier outage and budget exhaustion | | | open | agent |
| S6 | Accessibility and multilingual review of the coach / hold / block / support product UX | | | open | human only |
| S7 | Decision diff (`pnpm shadow-report diff`) for every policy revision change since the last signed checklist, each change reviewed | | | open | agent (prepare), human (review) |
| S8 | Prosocial intervention prompts distinguish victim reports, quoted language and ordinary boundaries; no harmful nudge during urgent disclosures | | | open | human only |
| S9 | New incident graph/OSINT functionality remains disabled unless separately reviewed and validated on synthetic and approved representative cases | | | open | human only |

## 2. Privacy

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| P1 | Legal / contractual basis for processing in this stage, and the institution's written contract | | | open | human only |
| P2 | Child consent context documented for any stage with learners | | | open | human only |
| P3 | AI Gateway payload logging disabled (`cf-aig-collect-log-payload: false`) and verified in the gateway's settings | | | open | human only |
| P4 | Log sample from the deployment shows content-free lines only (no request text, tokens or free-form errors) | | | open | agent (prepare), human (verify) |
| P5 | Retention (`HM_RETENTION_SECONDS`) and erasure path agreed with the institution | | | open | human only |
| P6 | Cross-account provider DPAs in place for every account that processes content | | | open | human only |
| P7 | Safeguarding incidents reach authorized personnel only; routing tested | | | open | human only |
| P8 | `HM_TENANT_MODES` reviewed: no `allowStudentShadow` for any tenant with learners | | | open | human only |
| P9 | Cloudflare AI Gateway *whole-log* settings reviewed; under strict privacy profile ordinary Gateway logs disabled; also verify Logpush jobs and destinations separately (request headers do not govern Logpush) | | | open | human only |
| P10 | Gateway response caching and model-specific prompt caching/other stateful features verified for each approved route; Worker logs, traces and exception reporting independently assessed | | | open | human only |
| P11 | Under-13 policy: every identified subprocessed payload has a valid COPPA authorization/notice and provider eligibility; OpenAI ZDR approval and project retention status verified before sending under-13 PII | | | open | human only |
| P12 | FERPA determination, school-official/direct-control/redisclosure terms, age-aware controls, access/correction/inspection and records retention/hold procedures approved | | | open | human only |
| P13 | Any optional pseudonymous graph and incident evidence store has documented necessity, separate access, expiry, pseudonym-scope policy and human-controlled identity reveal; no durable student reputation dossiers | | | open | human only |
| P14 | Test logs/Logpush/export sinks with synthetic sentinels and test derived-record erasure and legal holds (cannot prove provider's internal deletion) | | | open | agent (prepare), human (verify) |
| P15 | Public/social media evidence collection is disabled by default; any opt-in has off-campus student speech review, source permissions, authenticity checks and case-scoped retention | | | open | human only |

## 3. Economics

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| E1 | Estimated gross cost per 1,000 evaluations from shadow-report receipts (state the basis: simulated or measured) | | | open | agent |
| E2 | Observed `moderated_inputs / model_calls` ratio, average and p95 input tokens, escalation and retry rates from real receipts | | | open | agent (prepare), human (accept) |
| E3 | Drift between ledger, provider usage and account invoice within the agreed tolerance | | | open | human only |
| E4 | Optional human evaluation labour costs estimated and budgeted | | | open | human only |
| E5 | Safety budget sized so distress paths stay funded when generative budgets are exhausted | | | open | human only |

## 4. Reliability

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| R1 | Rollback drill passed at the release commit (`pnpm rollback-drill --out drill.json`): classifier outage fails closed for students; policy pin and rollback match the predicted diff; idempotent replay survives restart | | | open | agent |
| R2 | Live rollback rehearsal on the target deployment (previous Worker version and previous policy revision restored, then re-promoted) | | | open | human only |
| R3 | Injection and role-spoofing fixtures pass; tenant spoofing returns 403 | | | open | agent |
| R4 | Hall Monitor unavailable: each product's behaviour verified (student surfaces fail closed) | | | open | human only |
| R5 | Workers AI 429 / outage: student requests held, receipts record unknown cost | | | open | agent |
| R6 | Policy downgrade attempt (weakening overlay, pinning the built-in floor) refused | | | open | agent |
| R7 | Provider invoice mismatch and budget exhaustion during a distress disclosure exercised | | | open | human only |
| R8 | [Incident runbook](incident-runbook.md) owners and paging contacts filled in | | | open | human only |

## 5. Performance

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| F1 | Baseline p50 / p95 per stage from the shadow report (deterministic, classifier, orchestration, total) | | | open | agent |
| F2 | Measured p50 / p95 classification latency and total added user-perceived latency on the target deployment | | | open | human only |
| F3 | SLO targets set from the measurements (no vendor guarantee is assumed) | | | open | human only |

## 6. Governance

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| G1 | Approved student scopes and teacher-visible logs documented | | | open | human only |
| G2 | Confirmed: no automated discipline and no subjective high-stakes grade based solely on Clef | | | open | human only |
| G3 | Override conditions (who may override a decision, how it is recorded) agreed | | | open | human only |
| G4 | Unresolved risks listed below with owners and dates | | | open | human only |
| G5 | Written district / co-op approval for this stage | | | open | human only |
| G6 | Identity and incident disclosure require documented legitimate educational interest and purpose; no AI-only unmasking, sanctions or permanent risk labels | | | open | human only |
| G7 | Protect personal block/mute and genuine protective reporting from abuse labels; delegated group mute/brigading adversarial fixtures reviewed | | | open | human only |
| G8 | Any student-facing nudge UX has age, accessibility, cultural/language, help-seeking and chilling-effect review | | | open | human only |
| G9 | External provider routing has signed allowlist, live retention/config evidence and safe fail-closed path; no implicit third-party fallback | | | open | human only |

## 7. Temporal operations and analytics (optional; required before enabling M9)

| ID | Item | Evidence | Owner | Status | Who |
|---|---|---|---|---|---|
| T1 | No student content, principal IDs, conversation/case IDs, free text or sparse sensitive labels in operational analytics; test strict metric schema and every Logpush/export path | | | open | agent (prepare), human (verify) |
| T2 | District IANA timezone and instructional calendar pinned; fall-back repeated and spring-forward missing local hour cases tested against actual event timestamps | | | open | agent |
| T3 | Distinguish event occurrence, report, queue, review and action clocks; validate matched denominators, coverage/missing bins, version changes and WAE sampling estimates | | | open | human only |
| T4 | WAE fixed three-month retention explicitly assessed; any stricter district TTL uses alternative store; no sampled WAE value used as exact incident or billing ledger | | | open | human only |
| T5 | Explicit trained urgent safeguarding coverage, after-hours escalation and live acknowledgment drill completed; Worker uptime is not a 24/7 human response guarantee | | | open | human only |
| T6 | Flightdeck role scopes, small cohorts, overlap/differencing, complementary suppression, export and teacher-facing restricted counts reviewed | | | open | human only |
| T7 | Any U.S. hourly benchmark cites source geography, date, metric event clock and denominator; no externally derived individual risk multiplier | | | open | human only |
| T8 | Before any T1 pilot, configure **independent** source/collector strict tenant+source+grade grants, distinct 32+ character per-tenant keys, opt-in switch, internal-only service binding and collector validate-only mode; confirm no public route | | | open | human only |
| T9 | Prove collector response is `persisted:false`, no case/metric storage binding exists, and outages or invalid config cannot affect moderation; replayed evaluations never emit duplicate telemetry | | | open | agent (tests), human (deployment) |
| T10 | Explicit district approval of student data processing and *no actual historical dashboard* claim; assess 5-minute HMAC replay risk and T2 dedupe/retention requirements | | | open | human only |

## Unresolved risks

| Risk | Impact | Mitigation | Owner | Review date |
|---|---|---|---|---|
| | | | | |

## Sign-off (human only)

| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| Safety lead | | | | |
| Privacy / DPO | | | | |
| Security | | | | |
| Finance | | | | |
| Product owner | | | | |
| District / co-op approver | | | | |
