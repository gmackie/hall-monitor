# Safety intelligence architecture — design index

Status: **proposal / research**, 2026-10-27. This folder describes a possible extension of Hall Monitor, **not deployed functionality**. A student deployment requires separate legal, security, safeguarding, accessibility, and model-calibration approval. Technical statements about the existing code below were checked against the main branch when this design was written.

## Existing service versus proposed system

The current repository is a product-neutral, request-scoped moderation/evaluation service for EducateOS and PlayTrek. The shipped Worker accepts text, digest and embedded-image evaluations; runs deterministic plugins and a Clef-flash/Clef classifier; applies policy profiles; and returns content-free findings, decisions and cost receipts. It has no student identity resolution, incident graph, private-chat ingestion, social-media crawler, case approval workflow, or nudge user interface. Student grades 6–8 and 9–12 currently hold image submissions, pending image-model calibration. Clef thresholds in packages/clef/src/classifier.ts are explicitly marked UNCALIBRATED.

Do **not** quietly extend the existing request/receipt API to accept identifiers, message histories or raw incident evidence. Preserve its non-content-storage guarantee. Implement any incident intelligence as a distinct, opt-in service and versioned contracts with an explicit data inventory, bounded storage, separate authorization and independent reviews. Product owners remain responsible for chat consent, user-interface behavior, and emergency safeguarding.

## Documentation map

1. [Moderation pipeline and providers](moderation-pipeline.md): low-cost streaming checks, multimodal AI, OpenAI and Meta crosswalks, economics and routing.
2. [Noul / decision registry](semantic-registry.md): versioned prompts, school-specific behavioral decisions, confidence calibration and evaluation.
3. [Pseudonymous temporal incident graph](incident-graph.md): observations, claims, hypotheses, corroboration and selective identity disclosure.
4. [Abuse patterns and student interventions](behavior-and-interventions.md): gossip, exclusion, spam, report brigading, role abuse, safety nudges and human review.
5. [FERPA, COPPA and student records](../privacy/ferpa-coppa.md): age-aware processing, education-record status, records-access rights and school authorization.
6. [Zero data retention and provider assurance](../privacy/zero-data-retention.md): what vendors actually guarantee, exceptions, deployment checks and failure modes.
7. [External evidence / limited OSINT](../privacy/external-evidence.md): high-school threat and harassment evidence with strict collection and identity-linkage limits.
8. [Validation, milestones and launch gates](../validation-and-rollout.md): acceptance criteria, evaluation methodology, operational sign-offs.
9. [Primary sources and research](../references.md): source links and claims that require revalidation.
10. [Temporal safety analytics LLD](temporal-analytics.md): dual-plane architecture, Cloudflare primitives, local clocks and sampling.
11. [Temporal metric catalog](temporal-metrics.md): exact denominators, timestamps, bias, availability and privacy.
12. [Safety and analytics API contracts](temporal-events-and-api.md): future endpoints, exact D1 case ledger, role scopes and event transport.
13. [Flightdeck operations UI](flightdeck-operations.md): dashboard specs, safe aggregation queries, permissions and analytics failure states.
14. [Staffing, queue and capacity model](temporal-capacity-and-operations.md): urgent 24/7 coverage, forecasting, human workflow and cost.
15. [U.S. time-of-day/week research](us-moderation-timing.md): Gaggle, North Carolina tipline, Reddit and trolling research with evidence boundaries.
16. [Temporal implementation blueprint](temporal-implementation-plan.md): concrete package paths, staged PRs, security matrix and human sign-off.

The synthetic/offline temporal reference implementation lives in [packages/temporal-analytics](../../packages/temporal-analytics/README.md).
[T1](../implementation/t1-trusted-telemetry.md) validates and discards input.
[V2](../implementation/t2-durable-telemetry.md) implements a durable outbox and exact coarse
receiver with trusted time/retention, but the receiver is not production-verified or enrolled
for real sources. The isolated W8b S0a evidence model does not establish runtime coverage.
No dashboard or identity graph is enabled. See the [capability matrix](../market/capability-matrix.md).

Current operational materials remain [the launch checklist](../launch/launch-checklist.md), [incident runbook](../launch/incident-runbook.md), and [rollback drill](../launch/rollback-drill.md).

## Product principles

- **Prevention and support, not surveillance or automated discipline.** Respond to confirmed or credible risk with proportionate student safeguards. Never impose high-stakes consequences solely from an inferred score.
- **Privacy-first and purpose-bound.** Restrict intake to disclosed, authorized school-controlled activities; private messages are *not* a carte blanche for broad peer profiling. Routine social preferences and critical opinions are not case evidence.
- **Observation is not truth.** Keep source events, probabilistic interpretations, and reviewed findings separate, with contradictory evidence and reversible conclusions.
- **Protect disengagement.** Personal ignoring, muting and blocking are normal rights. Differentiate them from disabling someone else's access to required activities.
- **Safeguarding beats score accumulation.** Credible imminent threats and severe risks take an expedited human path; a point threshold must not delay help.
- **Minimum necessary access.** Teachers may see broad class-level guidance but not gossip dossiers; safeguarding staff see case-specific material based on documented role, purpose and authorization.
- **No invisible model routing.** Provider, modality, student age, data classification, contract, retention and log settings govern each outbound request; unauthorized routes fail closed.
- **No permanent social graph.** Keep short-lived, case-scoped evidence with expiry and lawful holds; avoid school-wide behavioral reputation scores.
- **Evidence of effectiveness.** Calibrate on consented or synthetic/legally permitted fixtures, test disparate errors and chilling effects, and measure whether nudges prevent harm.

## Non-goals

No general-purpose student social-network intelligence; no ingest of private accounts or DMs on external platforms; no facial recognition or shadow-account discovery; no scraping minors' feeds; no AI decisions on guilt, dangerousness, mental-health diagnosis, or disciplinary guilt; no automatic student identity reveal from aggregated scores; no commercial re-use or training on student content by default.

## Decisions requiring human approval

Before real-student pilot: district privacy officer and counsel approve legal basis, published notices, school data-processing terms and age/consent routes; safeguarding lead approves emergency escalation; security officer verifies processors, retention, logging and access boundaries; model-evaluation owner signs calibrated thresholds and fairness review; district leadership approves intervention UI and the ability to appeal. These sign-offs are **not** satisfied by merging this documentation.

## Recommended order

Extend the synthetic evaluation corpus and provider adapters first; add deterministic social-action events second; trial private, non-punitive nudges in approved school-managed surfaces third; enable optional case-scoped evidence correlation only after a separate privacy review; leave cross-conversation profiling and OSINT out of the initial K–8 release. See [milestones](../validation-and-rollout.md).
