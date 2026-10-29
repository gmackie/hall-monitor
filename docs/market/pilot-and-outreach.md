# Pilot offer, procurement plan and outreach playbook
**As of 2026-10-28. No named prospect has been approached or accepted. No student-data access is authorized.**

**W1 clarification, 2026-10-29:** the [charter](../launch/pilot-charter.md) is explicitly pending;
the [two-page pitch/privacy FAQ](pilot-brief.md), [capability matrix](capability-matrix.md) and
[custody decision](../privacy/record-custody-decision.md) are the current discovery materials.
Open-source licensing is intended, with no root license selected. Existing packages are distributed
through a private authenticated registry. Draft outreach is not permission to send it, and public
contacts from the research snapshot must be reverified when outreach is authorized.

## 1. First-meeting positioning

### One-line

“Hall Monitor evaluates content inside an explicitly integrated school-controlled tool. We propose
a synthetic-first study of private preventive prompts, with institutional control and a qualified
referral path.”

### Thirty-second explanation

“Schools already have tools to flag unsafe messages. We're exploring a narrower gap: distinguishing harmless jokes and reporting from repeated social exclusion, rumor forwarding or students abusing group mute/report controls—and guiding behavior *before* it escalates. The system uses a small context-aware classifier and deterministic rules, is designed to keep teachers out of private case content absent legitimate review, and runs in a school-controlled environment. We are not proposing continuous personal social-media monitoring or automatic discipline. We're looking for a research or school partner to test the approach on synthetic materials first and only later, with consent and legal approval, a small authorized discussion surface.”

Avoid marketing “zero data retention guaranteed by cryptography,” “false positives solved,” “detects all bullying,” “24/7 protection,” “COPPA/FERPA certified,” or “AI understands a child's intent.” These cannot currently be supported.

## 2. Two different offers

### A. Research/innovation partner (Michigan Virtual / Oakland Schools)

**Ask:** one 30-minute fit discussion; if aligned, one named education research/safeguarding co-designer for an evaluation protocol; advice on district permissions and introductions to an interested school. No initial transfer of real student records.

**Deliverables (proposed six-week co-design):**
- Signed problem statement, host/surface/data inventory, existing-vendor gap review, and student privacy/procurement constraints.
- Synthetic labeled corpus of bullying/harassment, gossip/exclusion, personal blocking, malicious delegated group mute, report brigading, defensive reporting, multilingual/quoted content, visual cases and age-fit.
- Benchmark rubric with blind human panel, false-intervention and missed-concern criteria, and appropriate source time-of-day workload examples.
- Non-student-data demo of Hall Monitor request/decision pipeline and proposed intervention UI.
- Joint decision memo: feasible authorized school host, integration path, incident response coverage, whether a later live pilot is ethical/necessary.

**Not offered:** production districtwide monitoring, free 24/7 response, public claim of certified student wellbeing impact, broad disclosure of minors' data.

### B. School-hosted design pilot (Catholic Central / Novi / Country Day / P-CCS)

**Ask:** staff sponsor in counseling/student culture, IT owner, privacy/records counsel, and a defined school-controlled communication workflow. A narrow pilot does not include passive collection of personal chat histories.

**A suitable first environment:** a new, opt-in grades 9–12 discussion tool or controlled class project collaboration where the institution can legitimately govern access, messages and report/permission events. The first student-free phase demonstrates how personal mute stays private while *delegated* group member removal is audit-supported.

**Scope constraints:** staff/synthetic-first; no claims of a functioning identity graph or external OSINT; urgent safeguarding path and teacher access protections independently validated before minors are involved.

## 3. Suggested 90-day stages and stop conditions

| Stage | When (illustrative) | Who participates | Activities | Entry/exit gate |
|---|---|---|---|---|
| S0: discovery | Weeks 1–3 | Sponsor, CTO/IT, privacy/safeguarding | Existing incident workflows/vendor coverage, approved school-managed surfaces, duty-of-care inventory, economic buyer | Named buyer + source. If none, stop. |
| S1: privacy and product design | Weeks 3–5 | Counsel/FERPA officer, student welfare lead, IT | Data inventory, COPPA/age scope, records retention, provider ZDR, parent/student rights, staff authorization, training/appeals | Written approved purpose, district data agreement and human response path |
| S2: synthetic/staff evaluation | Weeks 5–8 | Trained adult evaluators and engineers | Label and run synthetic corpus; role abuse, rumor, retaliation, ambiguous consent; no real student content | Per-category sensitivity, false restriction and access security verified by humans |
| S3: optional limited live exercise | Weeks 9–12+ only if approved | Small opt-in grades 9–12 activity under an approved institutional protocol | Student-facing non-punitive prompts and reporting; avoid persistent social graph and any unauthorized data export | Notices/consent and independent safeguarding, security and educational review fully signed |
| S4: independent evaluation | After exercise | School safeguarding, research partner, student/parent voice | Review false positives, genuine help seeking, accidental disclosure, participation harm, operating costs, acceptable interventions | Continue, revise or shut down with agreed criteria |

The timeline is a planning sequence, **not a promise that student testing can begin in 90 days**. A school may require months of contract/legal/privacy review. If no approved staff response exists for urgent cases, omit automatic threat ingestion from live scope and provide a clearly staffed referral process.

## 4. Safeguarding protocol

- **Severe/immediate concerns:** Direct to an already operating, trained human safeguarding/emergency pathway per school policy. No report-count threshold, invisible Monday-morning queue or model-only unmask.
- **Interpersonal harm:** Contextual evidence with clear counterevidence, human-reviewed case if justified; no inferred permanent character profiles or automated sanctions.
- **Routine friction:** Student can revise or continue if content is legally/policy permissible. Curated prompts must not tell students that other children secretly reported them.
- **Personal boundary:** Ignoring or muting remains an individual's right; repeated contact after a protected block is a separate signal.
- **Student rights:** Student/parent notices, age-appropriate assent/consent when needed, help path, appeal/correction, FERPA review/export and a data deletion/hold process.
- **Model/privacy:** Under-13 default excluded from first pilot; FERPA applies to maintained individual records of older students as well; ZDR external model routing must be specifically approved and configured.
- **Monitoring boundary:** School-managed and disclosed pilot spaces only. No personal devices' DMs or generalized social-media OSINT.

## 5. Evaluation scorecard (pre-register and obtain independent human review)

| Dimension | Metric | Interpretation and stopping rule |
|---|---|---|
| Classification reliability | Recall/precision by approved Noul risk, grade and language; calibration; abstention | Compare against blinded expert-labeled synthetic and authorized cases. Severe missed warnings or systematic discriminatory errors stop rollout pending review. |
| Wrongful moderation | Rate of unjustified holds/mutes, reversed decisions, complaints about bias | Must be very low under pre-agreed threshold; no automatic sanction. |
| Student trust and participation | Student/guardian opt-in rates, reports to trusted adults, interviews on comfort and privacy | A fall in reports may indicate chilling, not a safer environment. |
| Prosocial nudge impact | Editing/continuation rate plus independently reviewed outcomes and protected reporting | A click or a revised message **is not proof** of reduced bullying. |
| Safeguarding operations | Staff review hours, queue response, actual qualified after-hours acknowledgment and escalation | Never equate an always-up Worker with staffed help. |
| Data governance | Access approvals/denials, unintended teacher access, provider route failures, erasure correctness | Any unauthorized student-content disclosure triggers pause and response. |
| Technical feasibility | Policy compatibility, integration effort, errors, p95 synchronous latency, replay/idempotency and downtime | Show repeatable adoption without compromising the existing content-free receipt guarantee. |
| Economics | Model usage, integration hours, support hours, qualified human cost, procurement burden | Compare full cost to Bark free/$3 and existing safety contracts. |

Suggested pre-registration artifacts: approved pilot protocol and intended surface, ethics/privacy assessment, student/parent/staff notices, threat/safeguarding runbook, case-access governance, synthetic fixtures and labels, model/version pinning, success/stop metrics, and independent evaluation plan. **Do not set numerical success thresholds solely from vendor marketing statistics**.

## 6. Pricing/partnership options to test

Because the core is intended to remain open source:
- **No-fee technical discovery and synthetic demo** (small bounded scope, not unlimited implementation).
- **Research-sponsored co-design**: partner grant, ISD funding or agreed fee for protocol, synthetic evaluation and usability research. Any contribution should preserve school independence and proper oversight.
- **Paid implementation services**: e.g. a *hypothetical* $5k–$20k fixed technical pilot setup if a school has sponsor funding, separately quote actual legal/contract/workflow services. Not a validated market price.
- **Institutional technical support**: hypothetical $3k–$15k annual maintenance/support agreement where it creates value. Disclose no bundled 24/7 specialist review.
- **Developer distribution**: platform integrations via support/enterprise licensing of services while the underlying code stays open source (license/community policy to be chosen).
- **Grant-funded public-good implementation**: measure adoption, deployment savings and welfare; revenue may intentionally be zero.

Do not use school data to improve a shared commercial model by default. Never offer a “free pilot” that secretly monetizes minors' information.

## 7. Discovery questionnaire: 12 sharp questions

1. What categories generate the highest-cost staff workload: content, social exclusion, rumors, self-harm, threats, unauthorized group actions?
2. Who decides when “someone ignored me” becomes bullying, versus voluntary disengagement?
3. Which **school-managed software** currently owns the actual 2-way messages and group permissions (not simply identity/LTI)?
4. Which safety products do you already pay for, and what do they miss or get wrong?
5. How many alerts/reports per day/week, by hour; what is your review staffing and response SLA?
6. Are certain platforms or counselors' conversations explicitly exempt from monitoring?
7. Can the school legally/technically run an opt-in controlled chat pilot without ingesting existing private histories?
8. What district-owned cloud/hosting and DPA arrangements can be authorized; how is ZDR checked?
9. What privacy worries would make students and parents reject this outright?
10. Which single nudge or reporting scenario would be worth piloting; what would make it harmful?
11. What governance reviews, security questionnaires, board/procurement thresholds or grant offices are involved?
12. Who can approve a two-week synthetic study, and what must be true to approve a student-facing pilot later?

Document direct answers; don't silently transform interview anecdotes into national statistics.

## 8. Outreach assets

### Michigan Virtual partnership inquiry

**Subject:** Proposal for Michigan K–12 privacy-first digital safety pilot research

Hello Michigan Virtual Institute team,

I’m developing Hall Monitor, a safety and moderation prototype intended for school-controlled digital learning and collaboration tools. Rather than expanding surveillance of students' personal accounts, we're exploring whether contextual classifiers and small, private prosocial prompts can address behaviors like exclusion from required projects, rumor forwarding and misuse of group moderation privileges.

I noticed Michigan Virtual's invitation to propose future EdTech pilots. Would your research/innovation team be open to a 30-minute discussion about a **synthetic-data-first** study, with educator and privacy review, before approaching a participating school? The immediate deliverable would be an evaluation protocol and working demonstration—not a request to access student messages.

I can share the proposed architecture and intended open-source distribution, FERPA/COPPA and provider-retention controls under design, and a proposed measurement plan.

Would you be the appropriate group for that discussion?

### Oakland Schools director of AI innovation

**Subject:** Countywide AI safety design question — student collaboration, no private-account surveillance

Hello Justin,

I'm developing Hall Monitor, a proposed district-controlled moderation and safety layer that works *within approved school learning applications*. Its focus is prevention and procedural abuse (e.g., repeated removal from required group work or report brigading), rather than monitoring students' personal social media.

Your team's focus on responsible AI across Oakland County seems particularly aligned. I'm looking for a technical/educational design critique and, if it seems promising, an interested local school to help define a synthetic-only pilot protocol. We would not request students' existing private communications or assume Oakland Schools can grant member-district data access.

Would 30 minutes with you and an appropriate student-support/privacy colleague be worthwhile?

### Independent high-school IT + counseling (Catholic Central, Country Day)

**Subject:** Small, privacy-first student digital safety research pilot?

Hello [IT/Counseling leader],

I'm working on a prototype intended to help school-controlled discussion tools distinguish overtly unsafe messages from ordinary student disagreement—and, potentially, identify harmful patterns such as rumor forwarding or misuse of group moderation controls. The intent is to provide private, constructive prompts before incidents escalate, while limiting adult access to private conversations.

I'm not proposing school-wide surveillance or replacing your existing safety vendors. I'd like to learn which *approved, school-owned* discussion activities might benefit from a synthetic/staff-only demonstration and what safeguards your counseling and technology teams would require.

Would you be open to a brief exploratory call? I'd be happy to send a one-page data-flow/privacy summary first.

### Public school mental health / culture leader (Novi or P-CCS)

**Subject:** Exploring prevention of relational aggression in school-managed collaboration

Hello [Director],

I was reviewing your public work on student wellbeing and relational aggression, especially rumor spreading, exclusion and impacts on classroom participation. Hall Monitor is a research prototype exploring whether privacy-first in-app nudges and carefully limited, human-reviewed incident evidence could support existing bullying-prevention practices.

I'm not requesting student records or proposing automated discipline. The first stage would be synthetic scenarios with educators, IT and privacy staff to see whether the approach solves a real problem without chilling student communication.

Would you be open to a 30-minute problem-discovery discussion, or could you suggest the right combination of safeguarding and technology leaders to consult?

**Send only once genuinely ready with a demonstration and policy paper.** These are **drafts, not messages sent**. Use institution-specific names and contact routes only when publicly confirmed, and comply with outreach rules.

## 9. Procurement sequence for a public district

Discovery → named safeguarding/education sponsor → IT integration feasibility → privacy/legal/records assessment and processor/DPA → consent and community consultation where required → security questionnaire and technical pilot specification → procurement/board approvals where applicable → staff-only validation → optional ethically approved live test → independent outcomes and decision memo. Contract/procurement thresholds vary by district, so verify rather than invent them.

For private schools, there may be fewer public bidding steps, but FERPA applicability (depends on covered funding), COPPA/operator conditions, state law, parental trust, insurance, school governance and safeguarding still require analysis; do not portray a private school as a privacy loophole.

## 10. Outreach cadence and funnel targets

**Not a sales forecast.** A practical first wave is eight organizations: two regional/research partners, four highest-fit school candidates and two alternates. Aim for **5 qualified conversations**, **2 serious co-design candidates**, and **1 named institution willing to consider a synthetic/staff-only study**, rather than “close eight paid contracts.” Revisit rankings based on actual responses, IT access and ethics approvals.

Sample cadence:
- Day 1: relevant published partner form or precise functional email; concise concept plus ask.
- After 5–7 business days: one courteous follow-up with a 90-second synthetic demo and privacy diagram.
- After another week: if appropriate, a single final referral question; then stop unless invited.
- Record opt-outs and route to the correct institutional person; never bulk-message individual teachers or students.
- If they decline, ask whether there's a specific reason (no unmet need, no permissible surface, privacy opposition, no staff capacity, cost) and correct the segmentation model.

## 11. First deliverables before outreach

- 2-page PDF/website pitch with distinct *implemented* vs *planned* capability labels.
- Live demo using four completely **fictional** interactions: quoted language vs threat; rumor forwarding vs supportive report; personal mute vs abusive delegated group mute; bait-and-report.
- Read-only sample Flightdeck hour-of-week dashboard with **synthetic** figures and clear synthetic watermark.
- Architectural diagram: narrow evaluation service → approved student-owned surface → possible future case-scoped safeguarding route → anonymous district aggregates; no direct personal social scraping.
- Vendor-neutral privacy FAQ: data contract, OpenAI/Cloudflare ZDR exceptions, no unapproved student data training, logs, COPPA/FERPA rights, identity disclosure, staff access, breach plan.
- Disqualifier checklist: if school needs monitoring of arbitrary existing personal accounts, automatic student discipline, hidden staff browsing or unstaffed emergency promises, this isn't the right product.
