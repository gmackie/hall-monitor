# Hall Monitor — market size, SAM/SOM, revenue sensitivity and unit economics
**October 28, 2026 · All figures explicitly described by provenance; hypothetical price and adoption assumptions are not actual sales or forecasts**

## 1. Population denominator

| Population | Latest referenced survey year | Seats / entities | Evidence |
|---|---|---:|---|
| Operating U.S. public schools | 2024–25 | 99,073 schools | [NCES CCD Table 2](https://nces.ed.gov/ccd/tables/202425_summary_2.asp) |
| Operating regular districts | 2024–25 | 13,289 | [NCES CCD Table 1](https://nces.ed.gov/ccd/tables/202425_summary_1.asp) |
| All operating education agencies | 2024–25 | 19,183 (includes charter/service/etc.) | [NCES CCD Table 1](https://nces.ed.gov/ccd/tables/202425_summary_1.asp) |
| Public-school student membership | 2024–25 | 49,269,882 | [NCES CCD Table 2](https://nces.ed.gov/ccd/tables/202425_summary_2.asp) |
| U.S. private K–12 school students | 2023–24 | 5,096,365 | [NCES PSS First Look, NCES 2026-015](https://ies.ed.gov/use-work/resource-library/report/first-look-ed-tab/characteristics-private-schools-united-states-results-2023-24-private-school-universe-survey) |
| Private K–12 schools | 2023–24 | 30,553 | Same PSS |
| Combined public + private student **ceiling proxy** | **mixed** | 54,366,247 | 49,269,882 + 5,096,365; not one survey year |

Do not count charter students again as private. Operating agencies are not all purchasing districts. Some schools have no eligible chat, no approved data agreement or no budget. Home education, higher education, camps and global schools are excluded. No U.S. school-based screening vendor revenue total was verified from primary evidence in this research.

## 2. Gross potential annual seat-equivalent TAM — sensitivity, not actual market spend

Assume for a hypothetical single student/year entitlement all 54,366,247 enrollments are eligible.

| Assumed annual equivalent per student | Gross U.S. seat-value proxy |
|---:|---:|
| $0 — open-source license | $0 direct license TAM |
| $2 | $108,732,494 |
| $3 | $163,098,741 |
| $5 | $271,831,235 |
| $8 | $434,929,976 |

These are *simple multiplication scenarios*. They should **not** be repeated as published market revenue, actual demand, financeable ARR, or willingness to pay. For the public-school-only base, $2 and $8 brackets would be ~$98.5M and ~$394.2M.

### Pricing evidence and competitive pressure

- [Bark for Schools marketing](https://www.bark.us/learn/products-monitoring/): free school content monitoring; Bark for Schools+ list at $3/student/year with $1,200 annual minimum. Strong evidence that a generic “we scan email for bullying” seat license cannot sustain premium pricing without additional value.
- [DCPS negotiated Lightspeed contract, p.3](https://dcps.dc.gov/sites/default/files/dc/sites/dcps/page_content/attachments/GAGA-2022-C-0368%20MVS%20Contract.pdf): 2026–27 option year at $1.92/student/year for Lightspeed Alert, 51,000 seats ($97,920) **inside a suite** including filtering/classroom/analytics. A specific historic public-contract schedule, not today's general quote.
- [Gaggle](https://www.gaggle.net/) and [Lightspeed Alert](https://www.lightspeedsystems.com/products/lightspeed-alert/) include human safety escalation; their pricing is not directly equivalent to raw inference classification.
- Actual buyer willingness to pay for **privacy-preserving contextual intervention** must be established in interviews. Some buyers may pay $0 for software but sponsor a pilot or implementation/assurance service.

## 3. SAM versus SOM: eligibility is not adoption

Define **SAM** as the fraction of the gross student-seat ceiling with a relevant, technically instrumentable, legally authorized **school-managed communication surface**. Define **SOM** as the fraction of that SAM Hall Monitor could actually capture within a stated period, given product readiness, school procurement, opt-in permission, integrations, competition and support capacity. This avoids conflating addressable seats with likely customers.

Let P = 54.37M mixed-year ceiling seats; E = eligible fraction (SAM = P × E); D = illustrative capturable share of that SAM (SOM = SAM × D); V = assumed annual equivalent seat-value. For an open-source product, a license may generate $0 and support contracts need a separate buyer-level conversion model.

### Purely hypothetical illustrative funnel at $3/seat equivalent

| Scenario | E: eligible share | SAM eligible seats | SAM equivalent annual value | D: assumed capturable share | SOM scenario seats | SOM equivalent annual value |
|---|---:|---:|---:|---:|---:|---:|
| Conservative | 10% | ~5.44M | ~$16.31M | 15% | ~815,500 | ~$2.45M |
| Base planning case | 25% | ~13.59M | ~$40.77M | 25% | ~3.40M | ~$10.19M |
| Optimistic | 40% | ~21.75M | ~$65.24M | 35% | ~7.61M | ~$22.83M |

**E, D and V have NO empirical validation.** “SOM scenario” here is a model of a hypothetical obtainable share, not a time-bound forecast, sales pipeline or claim of feasible revenue. It likely overstates realistic startup adoption, particularly while the current service lacks school chat integrations and a live pilot. The three-year sales-conversion model below is narrower and should be favored for decision-making.

As another sensitivity, E = 20–35% gives a hypothetical relevant footprint of ~10.9–19.0M students. At $2–$5/seat-equivalent that yields ~$21.7M–$95.1M annual **SAM value** before adoption. None of these amounts is a certified market estimate.

## 4. Serviceable obtainable market (SOM): 3-year planning illustration

Two channel structures matter more than total U.S. enrollment:

**Independent-school route:** 1–3 prototype schools → 5–20 supported institutions, paying installation/service/assurance fees (illustrative $3k–$20k/year each after initial implementation). At 10 institutions × $10k/year, ~$100k annual support revenue. No assumption of an approved student-data pilot.

**ISD / public-district route:** 1 ISD sponsor + separately consenting districts → district-owned open-source deployments; hypothetical one-time project/support engagements of $10k–$75k based on integration complexity and professional service hours. The ISD cannot directly authorize all member district records.

**Platform/SDK route:** 1–2 EdTech platform integrations reaching many seats but with a different buyer, dependency on shipping developer tooling, legal/data retention obligations and partner distribution terms. Pricing likely enterprise/service-level rather than per student.

A 3-year SOM cannot credibly be forecast solely from the public sources. Define go/no-go from signed intent and validated deployment effort. **Do not record hypothetical support contracts as ARR.**

## 5. Unit economics reality check

Inference input cost model:
- Monthly eligible evaluations M = 1,000,000 (illustrative).
- Clef routed 15%, input 600 tokens/routed, published example $0.038 per 1M input tokens.
- Total routed inputs = 90M tokens → **$3.42 model input charges**.
- Review 0.13% of evaluations (illustrative vendor-like sensitivity, **not** Hall Monitor measured rate) → 1,300 reviews.
- 90 sec per review → **32.5 hours** at hypothetical fully loaded $35/hour → **$1,137.50** labor for review processing **alone**.

Excludes storage/network, image processing, retries, salaries, training, management, 24/7 staffing, human safeguarding specialists, insurance, legal/records workflows, sales/support and security. The cheap model bill is **not** a $3.42/month moderation business. Staff workload and qualified coverage dominate.

Production economics should be measured with the already implemented [content-free cost receipts](../../README.md), not WAE sampled telemetry. Temporal source and staffing modeling are specified in [engineering PR #11](https://github.com/gmackie/hall-monitor/pull/11).

## 6. Grants and procurement

The [federal Title IV-A SSAE program](https://www.ed.gov/grants-and-programs/formula-grants/school-improvement-grants/student-support-and-academic-enrichment-program-title-iv-part) lists **$1.38B fiscal 2026 funding** across well-rounded education, safe/healthy students and effective technology; eligibility/allocation are administered through state and local grants. This is **not a Hall Monitor procurement budget** and may not qualify for a given district's proposed use. Assess through the district grants office and allowable-use/needs-assessment procedures rather than assuming funds are available.

Other possible sources requiring qualification: district student-support and instructional-technology budget, educational research pilot funds, ISD shared services, private-school innovation/endowment gifts, foundations with youth mental-health or civil-rights focus. No named available grant award is implied.

## 7. Variables to verify in 10 discovery interviews

1. Number of students actually on **school-controlled two-way chat or forums** in the desired grades (not student body count).
2. Permitted source system, integration surface and degree of control over moderation permissions.
3. Current vendor and term/renewal date; whether there is a product gap versus existing Bark/Lightspeed/Gaggle.
4. Annual spend *specific to relevant work*, and existing team time spent reviewing routine alerts.
5. Staff availability nights/weekends and existing outsourced human response agreements.
6. FERPA/COPPA/under-13 contract constraints; approved cloud/data transfer and logging.
7. Willingness to fund independent evaluation, support, installation and training versus seat license.
8. Technical change required in the host's apps and the opportunity cost to school IT.
9. Quantified acceptable false blocks/review load; student/guardian acceptance and appeal mechanism.
10. Named decision maker, required approvals, procurement thresholds, board cycle and security review timing.

**If none has an instrumentable school communication surface, the initial school-monitoring TAM is irrelevant to our actual product.** Build controlled student-collaboration product integration first, or shift initial paying customer to EdTech development platforms.
