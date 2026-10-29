# Hall Monitor — U.S. Market Prospectus
**Research snapshot: October 28, 2026 · Draft for customer discovery and product validation · Not an offer or a claim of pilot commitments**

Related engineering: [architecture](../design/README.md), [current program HM-16](https://tasks.gmac.io/gmacko/issue/HM-16),
[capability matrix](capability-matrix.md) and [pending pilot charter](../launch/pilot-charter.md).
The historical GitHub planning issue is not the active backlog. This prospectus is an
**independent research proposal**. Hall Monitor is a request-scoped text/image evaluator with
deterministic plugins, Clef and district policy profiles. Durable telemetry source exists but
real collection/coverage/reporting acceptance is incomplete. It does **not** yet contain the
social-incident graph, student nudges, safeguarding case service, school source integrations or
operational Flightdeck dashboards described here.

**Distribution clarification, 2026-10-29:** open-source distribution and the commercial model below
are intentions. No root license is selected; existing packages use a private authenticated registry.
No host or study is authorized. See the [pitch/privacy FAQ](pilot-brief.md) and
[custody decision](../privacy/record-custody-decision.md).

## Executive thesis

**Offer a privacy-preserving, district-controlled layer for safer conversations and group participation in school-owned educational applications.** Detect not only explicit abuse and unsafe media, but contextual patterns such as repeated exclusion from required activities, misuse of delegated group mute/reporting controls, reputation attacks and harassment by multiple participants. Use modest, private prosocial interventions where justified and keep identifiable evidence available only for appropriately authorized safeguarding cases.

This is not a new device agent, universal private-message scraper, 24/7 emergency dispatch service or automated disciplinarian. Compete initially on **embedded developer-friendly APIs, provenance and policy, preventive behavior, low human-exposure risk, open-source deployment and transparent compliance controls**, rather than attempting to out-monitor Gaggle/Lightspeed/Bark.

**Customer strategy:** First sell a *design partnership*, not a district-wide surveillance subscription. Pair a validation/distribution intermediary (**Michigan Virtual / Oakland Schools**) with one legitimately authorized high-school operating host (**Detroit Catholic Central or Novi**). Pilot on an explicitly school-managed, instrumentable surface and test failure modes on synthetic/staff content first. Ship only after district legal, safety, security and student privacy approvals. Commercially, an open-source core with optional paid installation/assurance/support is more plausible than a per-message API fee.

**Buyer risk:** Any school can decline monitoring of student private discussions. Existing competitors already have fixed-price and even free entry-level offerings, and Hall Monitor currently lacks the integrations and human safety operations they provide. No organization researched here has indicated that it wants to buy or pilot Hall Monitor.

## Market demand: why schools investigate safety software

- [CDC YRBS results](https://www.cdc.gov/mmwr/volumes/73/su/su7304a3.htm) and [StopBullying.gov](https://www.stopbullying.gov/resources/facts) document electronic bullying, rumor-spreading and social exclusion among students. These describe population concerns, **not procurement demand or a validated Hall Monitor incident rate**.
- Schools already buy content monitoring, web filtering, SEL and threat assessment software; [2025 JMIR content analysis](https://www.jmir.org/2025/1/e71998/) identified 14 online school-surveillance companies across device, school-account and social-media contexts.
- [Bark for Schools](https://www.bark.us/learn/products-monitoring/) offers free monitoring and a $3/student/year plus tier; [Lightspeed Alert](https://www.lightspeedsystems.com/products/lightspeed-alert/) advertises 24/7 specialist review and broad content coverage. The bar for “we flag bullying text” is therefore already high.
- [Gaggle's annual safety-report materials](https://news.gaggle.net/student-safety-report-2025) provide evidence of multi-billion-item screening scale, but do not provide independent ground truth that vendor detection reduces bullying. Hall Monitor must test efficacy rather than claim it.
- A [2025 peer-reviewed study of school surveillance](https://www.jmir.org/2025/1/e71998/) also documents privacy/efficacy concerns. A system perceived as a student social-dossier builder can lose parent/student trust and be rejected outright.

## Product scope and core buyer benefits

| Buyer | Job to be done | Distinct pilot deliverable | Disqualification |
|---|---|---|---|
| Head of Student Life / Counseling / Safeguarding | Respond appropriately without a flood of mistaken reports; allow students to ask for help | Private nudges, contextual report handling, selective evidence access | No trained accountable staff, secrecy around monitoring |
| District CTO / CIO / Privacy Officer | Enforce FERPA/COPPA/ZDR rules without opaque vendor egress | District-owned deployment, data inventory, signed policy/Noul registry, provider route gate, audit | Cannot approve permitted school-managed data source |
| Superintendent / Principal | Improve required group participation, reduce harmful escalation, build trust | Reported false interventions, group access restoration, student confidence, prevention evaluation | Wants automatic discipline or “identify the bad kids” |
| EdTech platform team | Add moderate/coach/report/approval tools quickly | Native request-scoped evaluation API and reference UI/SDK | No supported surface or platform control |
| ISD / education research partner | Coordinate privacy-conscious innovation across schools | Synthetic evaluation kit, joint study protocol, deployment patterns | Assumes automatic access to districts' identifiable records |

### Initial product packaging

**A. Safe Interaction API (near-term).** Existing Hall Monitor content evaluation + versioned school-specific decision pack + deterministic spam and delegated permission checks. Surface-owned optional message-rewrite nudges and reporting. No persistent student profiles.

**B. Protected Incident Evidence (later, gated).** Temporary case-scoped behavioral event correlation; uncertain target identification; provenance, contradictory evidence, district-operated identity vault, Gatekeeper disclosure approval, FERPA record rights. This is a substantial future product with separate legal, implementation and test gates.

**C. Safety Operations Analytics (later, gated).** Content-free hourly/week-of-day workload patterns, eligible-message denominators, human queue latency, privacy and ZDR health, cost, and after-hours coverage through Flightdeck. The current code has **synthetic/offline primitives only**.

**D. Optional External Evidence (future).** Student-submitted screenshots/URLs and narrowly authorized incident-scoped public research. No general child OSINT or mass profiling.

### Why this is not a replacement for current monitoring vendors

The [Lightspeed Alert](https://www.lightspeedsystems.com/products/lightspeed-alert/) product already scans device activity, Google/Microsoft 365 and Canvas and includes 24/7 human specialists; [Bark](https://support.bark.us/en/articles/13461523-bark-for-schools-monitoring-filtering) has extensive school-account scanning. Hall Monitor does not. Initial deployment must complement these products or protect a school-managed surface that existing tools cannot natively control. Full-screen/extension/system-wide interception is deliberately **not** in our initial plan.

## U.S. market sizing and monetization hypothesis

**Population:** [NCES CCD 2024–25](https://nces.ed.gov/ccd/tables/202425_summary_2.asp) reports **49,269,882 public students**, 99,073 schools; [CCD agency table](https://nces.ed.gov/ccd/tables/202425_summary_1.asp) identifies 13,289 operating regular districts among 19,183 operating education agencies. The [NCES PSS 2023–24](https://ies.ed.gov/use-work/resource-library/report/first-look-ed-tab/characteristics-private-schools-united-states-results-2023-24-private-school-universe-survey) reports approximately **5,096,365 students at 30,553 private schools** (see survey tables). Combining two **different school years** yields a rough public+private population ceiling of **54,366,247 seats**, not an exact current-year count.

**Top-down annual monetization sensitivity (NOT observed market revenue):**
- At hypothetical $2/student/year across all 54.37M students: **$108.7M**.
- At $5/student/year: **$271.8M**.
- At $8/student/year: **$434.9M**.
- At $3/student/year: **$163.1M**, comparable only in list-price terms to Bark for Schools+, not a valuation of equal services.

These seat-equivalent amounts are a **TAM proxy** if every student had an eligible product and was paid for. They are neither estimated *existing category revenue* nor attainable Hall Monitor revenue. Coverage across schools, contract models, approved chat surfaces, near-zero open-source license pricing, pricing competition and district policy could reduce payable seats dramatically. See [market size model](market-sizing.md) for SAM/SOM and support-service economics.

**Public observed price comparators:**
- [Bark for Schools free/$3 + $1,200 minimum](https://www.bark.us/learn/products-monitoring/) — published marketing list; scope differs.
- [DCPS Lightspeed contract, page 3](https://dcps.dc.gov/sites/default/files/dc/sites/dcps/page_content/attachments/GAGA-2022-C-0368%20MVS%20Contract.pdf) — Lightspeed Alert $1.92/seat in 2026–27 option year as part of a larger suite, not standalone market quote.
- Other district contract ceilings must not be treated as a per-student national mean.

**Proposed open-source commercial model:** Free district-owned core, optionally paid integration/configuration/privacy review support, hosted operations support (without assuming the vendor is the data controller), training, additional integrations and managed *technical* SLA. Any 24/7 professional safeguarding response must be a separately contracted qualified human service, not covered by software support. Use 2–3 customer discoveries to assess ability/willingness to pay before publishing an actual price card.

## Customer segmentation and pilot strategy

| Segment | Pilot value | Commercial procurement | Initial priority |
|---|---|---|---|
| Independent high schools | More focused governance, older minors, faster decision path possible; no claim that private school law is “light” | Tuition-funded budgets, board/head of school, counseling + IT signoff | **Primary direct host** |
| Mid-size innovation-focused public districts | Representative FERPA/consent practices, trusted staff, broader transferability | Formal CIO, privacy, student support, procurement and board | **Primary validation host** |
| ISDs/ESAs and state virtual/research providers | Direct multi-district knowledge transfer and introductions | Cannot alone authorize another district's student records | **Primary distribution/design partner** |
| National EdTech chat platforms | High leverage via one SDK integration with in-product controls | Platform legal, product, data protection, vendor review | Second-stage channel |
| K–8 and private online communities | High need but COPPA/age burdens and special privacy risk | Under-13 approval and sensitive disclosures | Delay until proven with older users |

**Critical unknown:** Does each candidate already operate an *authorized communication surface we can control and instrument*? Google Classroom/LTI/Blackbaud integrations do not magically provide authorized access to private messages or permission events. The pilot must not be sold before confirming the integration.

### Proposed order of approach

1. **Michigan Virtual** to request research/design study and school introductions via its [public pilot-partnership page](https://michiganvirtual.org/institute/pilots). No active pilot slots are advertised as of this snapshot.
2. **Oakland Schools** AI Strategy & Innovation / Student Culture teams to obtain a district-safe evaluation review and local school introducer; not a blanket buyer for member districts.
3. **Detroit Catholic Central** IT + counseling for a narrow staff/synthetic first host and possible grades 9–12 pilot (pending written consent and school authorization).
4. **Novi Community School District** Mental Health & Wellness Director; explicit published [relational aggression](https://www.novi.k12.mi.us/community/novi-mental-health-alliance) concerns offer a problem-first conversation.
5. **Plymouth-Canton** School Culture & Climate Director; public [policy includes rumors, manipulation of relationships and shunning](https://www.pccsk12.com/departments/human-resources/school-culture-climate).
6. Country Day Upper School, Northville, and Wayne RESA as alternate host/channel paths.

See [full ranked lead cards](pilot-prospects.md). This ranking is analyst judgment based on public fit and routes, **not measured likelihood**. Neither referrals nor sale intent have been verified.

## Operating model and U.S. time-of-day insight

Student safety incidents, anonymous reports, classifier flags and human reviews are distinct event clocks. [Gaggle's historical 2021–22 report](https://images.g2crowd.com/uploads/attachment/file/1288126/Through-the-Gaggle-Lens---The-State-of-Student-Safety---2021-22---REPORT.pdf) reported 35% of its detected incidents after its school-day window. A [2026 North Carolina study of 44,998 tips](https://pmc.ncbi.nlm.nih.gov/articles/PMC13430530/) found school-hour volume but a greater **proportion of life-threatening reports** in overnight tips. This is not a claim about the risk of ordinary late-night messages, nor nationally representative U.S. hour-by-hour moderation.

For a school pilot, plan 1) immediate software evaluation, 2) nonurgent routine-review next working day as permitted, and 3) *credible urgent concerns* routed to an actual trained, authorized human path. Never promise 24/7 human response solely because Workers is running. Full temporal LLD and synthetic staffing tests are in [architecture PR #11](https://github.com/gmackie/hall-monitor/pull/11).

## Top reasons a pilot may fail

1. **Missing host surface.** Staff use closed Google/Blackbaud/Teams interfaces where Hall Monitor cannot lawfully or technically intercept conversation. Mitigate: host a specifically integrated pilot application or LTI tool that institution controls; do not promise universal monitoring.
2. **Privacy opposition.** Parents/students reject surveillance or inferred social profiles. Mitigate: published narrow scope, no personal/off-campus monitoring, ephemeral evaluation, student advisory feedback and deletion/access workflows.
3. **Unsafe or inadequate triage.** False negatives/positives and no trained review support. Mitigate: synthetic validation and externally governed human response, no automatic punishment/unmasking; do not launch a silent-monitoring product.
4. **Weak evidence of benefit.** Lower report counts could reflect chilling effects; edits after nudges don't establish bullying reduction. Mitigate: independent review and student trust metrics.
5. **Price competition.** Free Bark, bundled filtering. Mitigate: positioning as app-embedded workflow/operating model and district control; monetize services only if demand exists.
6. **Cloud spend is not the buyer's main pain.** Human safeguarding staffing and procurement dominate model inference expense. Mitigate: report *total* cost, not just token bills.
7. **Unbounded data rights.** Staff want individual gossip searches and permanent risk scores. Mitigate: decline that scope; purpose-based case review only.

## Recommended 90-day effort

**Days 0–14:** Sharpen 2-page pitch, independent FERPA/COPPA/privacy FAQ, synthetic 4-case demo, data-flow diagram, integration inventory, five targeted introductions, Michigan Virtual pilot form and Oakland Schools research conversation.

**Days 15–35:** Seek 5–8 discovery interviews across safeguarding and CTO roles. Qualify current pain, existing vendors, permitted student communication surface, legal authority, reviewer staffing, success criteria and whether the institution would sponsor further work.

**Days 36–60:** With a willing partner, run **staff-only/synthetic retrospective evaluation** of content, roles and required group membership; no covert surveillance, no automated student nudges or case tracking.

**Days 61–90:** If written gates, reviewers and suitable technology are in place, propose a *small, optional, clearly disclosed* high-school pilot (e.g. one controlled discussion activity). Otherwise finish design study and seek additional hosts rather than deploying school-wide.

**Gate to expand:** calibrated errors, student/guardian and counselor acceptance, specific permitted surface, export/correction and deletion functionality, documented provider ZDR/processor terms, qualified response pathways, and measurable evidence that intervention doesn't suppress legitimate help-seeking.

[Detailed pilot methodology and outreach](pilot-and-outreach.md).

## Decision / investment recommendation

Invest first in **customer discovery and an ethics-reviewed prototype**, not a districtwide contract or nationwide social monitoring system. A clean go/no-go threshold is: one credible school-controlled integration, one committed staff sponsor, an independent privacy/safeguarding owner, and at least one repeatable use case for prevention or administrative abuse detection that existing vendors do not solve within the host's product.

The strongest first transaction may be a funded research/design partnership, not license ARR. If Hall Monitor remains a zero-revenue open-source public good, measure adoption, deployment cost and independent student welfare outcomes; the TAM calculation then represents **avoided procurement spending and potential supported deployment demand**, not an implied commercial exit.

## Report map

- [Market-sizing appendix](market-sizing.md)
- [Competitive landscape](competitors.md)
- [Ranked Michigan pilot and channel targets](pilot-prospects.md)
- [Pilot, procurement, sales/outreach and scripts](pilot-and-outreach.md)
- [Research/source register](sources.md)
