# Validation plan, implementation milestones and go/no-go gates

**Proposal, 2026-10-27.** This document adds planned milestones to the existing Hall Monitor project. **No student deployment, new APIs, graph storage, nudges, legal compliance certification or provider integrations are implemented by these documents.**

## Current baseline (verify against main when implementation starts)

Implemented: versioned evaluation schemas; student/educator policy profiles; deterministic plugins; Clef text/image requests; content-free receipts and idempotency in Durable Objects; synthetic shadow corpus, policy comparison and rollback drill; tenant JWT/role-like scopes. Student images are currently held pending calibration. Clef classification thresholds are placeholders. There is no graph, disclosure vault, event bus, cross-provider governance gate, parent records-access workflow, OSINT adapter, or messaging UI here.

Existing launch docs: [checklist](launch/launch-checklist.md) and [incident runbook](launch/incident-runbook.md). Existing test scripts: pnpm lint, pnpm test, pnpm shadow-report, pnpm rollback-drill.

## Milestone sequence

| ID | Deliverable | Acceptance criteria | Human gate |
|---|---|---|---|
| M0 | Scope, data inventory, legal/privacy review | Mapping of school surfaces, ages, student notices, education records, COPPA roles, provider and processor agreements; non-goals agreed | District privacy officer + counsel |
| M1 | Taxonomy & benchmark corpus | Signed decision-pack versions; synthetic cases for bullying, ambiguity, multi-language, media, protective reporting, exclusion and report misuse; calibrated threshold methods | Educator/safeguarding and model-eval lead |
| M2 | Governance Gate | Per-tenant/age/purpose/modality provider allowlist; actual OpenAI ZDR/project checks where used; Cloudflare logs/Logpush/cache verification; fail-closed tests | Security/privacy owners |
| M3 | Platform action signals | Separate versioned event ingress for school-managed chat/group actions; no raw evidence on shared event bus; tenant auth, source permission verification, rate limits and TTL | Product owner + security |
| M4 | Ephemeral case-candidate engine | Reified evidence/inference graph, uncertain entity attribution, independent-source grouping, contradictions, expiry; no student reputation scores | Safeguarding + privacy review |
| M5 | Prosocial nudge & protective UX | Optional pre-send prompts, personal protections, accessible and multilingual support/report paths; no unauthorized teacher disclosure | Students/parents, educators, safety reviewers |
| M6 | Restricted safeguarding cases | Purpose-limited approval/unmask, case state machine, appeal/correction, parent/eligible-student access and multi-student review, deletion/holds | Records officer + district counsel |
| M7 | Live pilot and effectiveness study | Synthetic/staff gates passed, opt-in authorized limited-scope pilot, independent monitoring of accuracy, equity, privacy, efficacy and appeal reversals | Formal district sign-off |
| M8 | Optional high-school external evidence | Submitted-evidence intake and tightly approved case-scoped public-source review; off-campus speech, consent, source authenticity checks | Separate source-specific approval |

**Don't treat any milestone as permission for production traffic.** Sensitive features ship disabled by default, behind non-bypassable policy and deployment gates. Each student scope needs renewed approval. Never enable live shadow traffic through the unsafe student-profile override.

## Recommended first PRs after documentation

1. Freeze/review existing classifier questions and write a provider-independent registry **without changing production safety thresholds**.
2. Add synthetic behavior examples for harmless personal mute/ignore, teacher-mandated groups, malicious group mute, hostile memes, bait-and-report, spam and genuine protective reporting; extend classifier eval reports with abstention/unsupported-modality handling.
3. Add a read-only privacy preflight that detects unexpected AI Gateway logging/Logpush/cache settings and verifies provider ZDR mode; do not require sending real student content to test it.
4. Specify a separately versioned safety-event contract in a new package, then implement authorized tenant-scoped source adapters with no raw payload receipts.
5. Prototype graph reasoning *offline on synthetic events*, measure false attributions, and have safeguarding/privacy teams decide if live correlation is justified.
6. Build student-report and review flows before enabling any punitive or surveillance-adjacent automation.

## Evaluation dataset and study design

Synthetic corpus should have positive, negative, ambiguous, and urgent examples of:
- repeated targeted insults/threats; self-harm disclosure; education quotation; consensual profanity;
- direct rumor spreading vs a student's request for help about a rumor;
- optional social invitation refusal vs coordinated exclusion from a required group;
- benign individual mute vs repeated misuse of entrusted group mute;
- report brigading vs many independent reports of an actual problem;
- provocation followed by out-of-context complaints;
- cross-room duplication and manipulated evidence that falsely increases independent corroboration;
- mistaken entity resolution across nicknames, pronouns, identical names and synthetic pictures;
- image-only, text+image, multiple images, unsupported categories, adversarial multimodal content;
- age-band and language variation, model outage, slow responses, quota exhaustion, policy drift and record deletion.

Later real student cases may be used for evaluation **only when separately authorized, appropriately minimized, governed and reviewed**. Do not collect learner data for generic commercial fine-tuning or preference learning. Avoid training on model labels as if ground truth.

## Metrics and reporting

Safety: per-category precision, recall, PR-AUC, severe-event missed detections, delay to trained human response, false protective blocks, wrongful group restrictions, erroneous attribution, appeal reversal.

Privacy: bytes of content retained per tier; expiration accuracy; provider-route audit rate; absence of content in sampled log/export sinks; disclosure count and purpose; legal access request turnaround; documented deletion and backup expiration.

System: L0 false negative sample rate, fraction routed to AI, multi-model escalation share, p50/p95 latency, retries, per-request cost (including images and staff review), operational outage minutes, case backlog.

People: student feeling of safety, comfort seeking help, rate of misleading nudges, accessibility issues, educational participation and chilling effects. A changed comment or lower count of reports by itself does not demonstrate fewer bullying incidents.

Evaluate by grade band, language and modality. Record calibration versions and confidence intervals; report where evidence is inadequate. Do not optimize only for number of detections.

## Safety and privacy hard gates

- District has authorized the exact purpose, student surface, age cohort, retention schedule and disclosed notices/consents; child-safety legal questions resolved.
- A designated safeguarding team approves urgent triage and availability outside school hours where relevant.
- No student identities or raw messages available in logs, receipts, unapproved embeddings, training sets or class dashboard.
- Provider routes, including OpenAI under-13 ZDR, are allowlisted, contract-approved and continuously verified; missing config blocks external calls.
- Ordinary personal muting remains private and unsanctioned; no punitive automation from sentiment or report volume.
- Case graph expires irrelevant assertions and supports inspection, appeal, correction, deletion and preservation holds.
- Human-reviewed calibration and documented thresholds have replaced UNCALIBRATED_THRESHOLDS before student-classifier enforcement.
- Image capabilities must be calibrated per grade band before the current student image-hold floor can change.
- Stage-by-stage failure drills, security checks, red team and equity/accessibility review passed with named responsible humans.

## Security review scenarios

Attempt JWT tenant spoofing and cross-tenant ID resolution; unmask without approval; parent export leaking another student's record; teacher querying small-cohort aggregates; forged evidence and compromised group moderator; emergency path abuse; stale retention attestation; gateway payload logging enabled by drift; Logpush export unexpectedly active; source-event redelivery/replay; deletion of an incident before a preservation hold; leaked prompt in a model error; CSAM sent to general model.

Test and document results. A process, legal review and human resources plan are necessary; code unit tests alone are insufficient.

## Rollout stages and rollback

Start with synthetic local shadow reports, then consenting educators/staff only, then a legally authorized limited pilot with students. For each stage run the existing launch checklist, verify model thresholds, compare policy revisions, record approvals and rollback trigger owners. Roll back to deterministic safety features or pause unsafe surfaces if error rates, disclosures, vendor retention drift or false exclusions exceed pre-approved limits. Never silently turn off protection or transmit student data to a cheaper fallback.

## Open policy questions

- What school-controlled surfaces, including private school-managed chat, have sufficiently specific authority and notice for inspection?
- What legally defensible retention lengths apply to various safety-signal and case tiers in each jurisdiction?
- What event volume and independent evidence justify restricted case review, and who approves the first pilot?
- What is the acceptable rate of wrongful classification/nudging by grade band and language?
- Should the incident graph live only in EducateOS (source owner), with Hall Monitor remaining permanently stateless?
- What non-identifying classroom analytics are still safe for very small groups?
- What actual processor agreements and account configurations are available for OpenAI, Cloudflare, local models and external evidence sources?

Treat unanswered questions as blockers to the corresponding feature, not values to fill in with guesses.
