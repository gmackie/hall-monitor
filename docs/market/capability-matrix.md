# Implemented versus proposed capabilities

W1-2026-10-29 · Source baseline: main `7a9ebdd` · HM-19 / HM-16

“Implemented” means source and local/canonical tests exist. Production acceptance needs the exact
deployment revision and authenticated checks. A merge, public health response or synthetic demo
alone does not verify an institution's configuration, staffing or student-data authorization.

| Capability | Source status | Deployment / use boundary |
|---|---|---|
| Authenticated text/image evaluation, tenant isolation, anti-replay and idempotent receipts | Implemented | Evaluator production exists; current target revision and authenticated acceptance still require delivery evidence |
| Deterministic rules and Clef primary/escalation with per-attempt cost receipts | Implemented | Default thresholds are uncalibrated; no new student applicability approval |
| Tighten-only policy floors and guarded shadow mode | Implemented | Learner shadowing is not an approved pilot mode |
| Student images | Intentional policy hold | Calibration and a new floor revision required before enablement |
| Immutable decision-pack registry | W2 implemented, HM-23 / merged PR15 | Production acceptance pending; installation does not calibrate or approve a profile |
| Synthetic corpus, shadow report and rollback drill | Implemented | Simulated-model reports test mechanics, not measured classifier efficacy |
| v1 internal telemetry | Implemented validate/discard protocol | Default off; `persisted:false`, no dashboard |
| v2 durable producer and exact coarse receiver, trusted time/retention | Implemented W6/W7/W8a | Separate receiver is not production-verified; no real enrollment or public reader |
| W8b coverage evidence model | Isolated S0a implemented; proof/runtime unfinished | Runtime coverage remains unavailable; silence/missing/expired counts never mean zero |
| Temporal/queue/cost reference models | Implemented synthetic/offline | Staffing simulation is not a response service or actual school data |
| Bounded reporting, suppression and Flightdeck integration | Proposed / owning work HM-22, FLIG-2 | No operational district dashboard, cross-district benchmark or school comparison |
| Provider/account privacy preflight and runtime governance | Proposed / HM-24 | Actual route/logging/cache/export/age eligibility and human approvals remain required |
| Student nudges / four-case social demo | Proposed / HM-27 and source owner | Only existing evaluator behavior can be demonstrated as implemented |
| Source reports, group permissions and correction/retraction contracts | Proposed / HM-25 and source owner | No universal LMS/private-message integration or invented source authority |
| Case-scoped assertion correlation | Proposed / HM-25 | No global social graph, intent certainty or reputation score |
| Restricted retained cases, identity disclosure and record rights | Proposed / HM-26, GATE-4 | Custody, independent authorization, holds/rights and qualified operations required |
| Independent pilot / human response | Pending accountable people and protocol | No committed host, 24/7 staffing, efficacy result or live exercise approval |
| Open-source license / supported distribution | Owner decision pending | Existing packages use private registry; no root license selected or new distribution promised |

The [prospectus](PROSPECTUS.md) contains market hypotheses. The [pilot charter](../launch/pilot-charter.md)
contains the proposed scope and pending decisions. Canonical backlog and acceptance live in
[HM-16](https://tasks.gmac.io/gmacko/issue/HM-16), not the historical GitHub planning issue.
