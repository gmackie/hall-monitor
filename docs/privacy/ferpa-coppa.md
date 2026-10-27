# FERPA, COPPA and school data governance

**Research and proposed controls, checked 2026-10-27; not legal advice or a compliance certification.** A school privacy officer and qualified education counsel must approve the actual deployment, agreement, notices, state-law posture, and incident workflow. FERPA and COPPA apply differently and can apply simultaneously.

## FERPA record classification

FERPA defines education records generally as records directly related to a student and maintained by an educational agency/institution (receiving applicable federal funds) or a party acting for it. See [U.S. Department of Education regulations](https://studentprivacy.ed.gov/ferpa) and [what is an education record](https://studentprivacy.ed.gov/faq/what-education-record).

| Proposed Hall Monitor data | Conservative product treatment |
|---|---|
| Named student incident, student-specific safety report or disciplinary/safeguarding outcome | Treat as protected education record |
| Student-specific inferred target, gossip/provocation score, case hypotheses, temporal pseudonym edges | Treat as protected education record when maintained and reidentifiable; inference is not exempt |
| Multi-student message excerpts, screenshot or school-stored media | May be records of more than one student; source being public does not automatically change this |
| Genuine de-identified aggregate classroom trend | Could be outside FERPA if identification is not reasonably possible, including via combinations |
| Stateless content analysis with no maintained derived record | The transient computation alone ordinarily does not create a *maintained* record; source message may still be a record |
| Content-free usage receipt | Evaluate whether linkage or metadata could directly relate to an identifiable student; don't assert universally exempt |

Pseudonymous ID != anonymous data: identities may be resolved by a school and topology/timestamps can reidentify participants. The **graph is student data**. Do not expose student-level graph queries to teachers or claim FERPA does not apply because IDs were hashed.

### Access, disclosure and correction

- FERPA [school-official exception](https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa) requires that a contractor perform a school function, remain under direct school control regarding records, obey use/redisclosure restrictions and meet the district's annual-notice criteria for legitimate educational interest. Vendor terms, subprocessors and hosted inference require their own review.
- Access by an employee **must be need-to-know**. A teacher's role alone isn't a right to inspect peers' private messages. Separate routine class climate from case-specific safeguarding review, with documented purpose and Gatekeeper enforcement.
- Parents/eligible students generally have [inspection rights within 45 days](https://studentprivacy.ed.gov/legal-basics), with state laws sometimes shorter. They can request amendments of records they believe inaccurate and use prescribed procedures. AI labels and rationale should be available for appropriate explanation and challenge.
- Multi-student evidence requires legally reviewed segregation/redaction/inspection. See [ED's video and multi-student guidance](https://studentprivacy.ed.gov/faq/faqs-photos-and-videos-under-ferpa); the same general access problem can arise in shared incident files.
- Do not destroy records while a pending inspection request prohibits destruction; obey applicable state schedules, litigation holds and other preservation duties. **No universal FERPA TTL** applies to all incident files.
- A genuine [health/safety emergency](https://studentprivacy.ed.gov/faq/what-records-or-information-can-be-disclosed-if-health-or-safety-emergency-exists) permits only condition-specific disclosures to appropriate parties where an articulable significant threat exists; document the rationale and recipients. Not permission for continuous general surveillance.

### Separation of responsibilities

EducateOS/district controls student authentication, parent rights, official record ownership, case decisions and the identity vault. Hall Monitor's existing Worker remains a narrow content evaluator. The *proposed* incident service would hold limited derived records under school control, with purpose, retention and access policies per record. Open-source/self-deployed software does not automatically make the operation legally compliant.

## COPPA: under 13, not “everyone in K–8”

COPPA governs covered services directed to children under 13 or knowingly collecting their personal information. Grade band is not a reliable age check: some middle schoolers are already 13 and some are not. Schools need a legally reviewed age/eligibility classification from their records, ideally without giving the classifier exact date of birth.

FTC [COPPA FAQs, school-consent section](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions): under its guidance, a school may authorize collection on parents' behalf where an operator contracts to serve the **school's educational benefit and no other commercial purpose**, after sufficient notice. This is limited to the school context. Do **not** assume signing a general school contract makes all subsequent social profiling, external social-media OSINT or vendor model training lawful.

The FTC [amended COPPA Rule](https://www.govinfo.gov/content/pkg/FR-2025-04-22/html/2025-05904.htm) became effective June 23, 2025, with most new provisions having an April 22, 2026 compliance date (certain sections differ). The FTC did **not** finalize the separately proposed formal school-authorization exception; review existing FTC school-consent guidance rather than treating proposal language as binding.

### Under-13 checklist

1. Identify COPPA-covered operator(s) and data flows, including tenant owner, Hall Monitor deployer, AI inference provider and any processors. Document role, jurisdiction, audience, purpose and approved mode.
2. Provide adequate notices to school/parents; obtain the authorization and consents required for the specific collection, use, disclosure, changed purpose and third-party transfer.
3. Minimize data: no default long-lived personal sentiment, peer network or off-platform OSINT. Prefer ephemeral, purpose-bound safety checks and student-initiated reporting.
4. Apply written retention/deletion and written information-security programs with service-provider safeguards. Restrict onward use and commercial profiling.
5. Honor applicable rights to review information, seek deletion and stop further collection, coordinating with legitimate school records retention/holds.
6. Keep identifiable student chat out of shared or commercial model-training datasets absent independent legal authorization and governance.
7. Test provider and log routes for under-13 information; OpenAI [explicitly requires implementing API ZDR before processing under-13 personal data](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance).
8. Escalate immediate dangers under applicable reporting and child-safeguarding law; ordinary “school authorization” is not a substitute for mandatory child-protection procedures.

### Practical age-aware feature policy (recommended, not legal grade mandates)

| Cohort | Default product approach |
|---|---|
| K–5 | Disclosed school-chat safety checks, student help/report tools, curated age-appropriate nudges, restricted urgent review; no relationship/OSINT graph |
| 6–8, under 13 | Same under-13 provider/consent rules; consider only brief case-scoped platform-action correlation after written assessment |
| 6–8, 13+ | FERPA and minors' privacy still apply; no blanket student profiling |
| 9–12 | FERPA, state and student speech protections; optional documented evidence-based case investigation, including appropriately submitted external material |

This profile governs collection purpose, source authorization, age handling, provider allowlists, modality, TTL, reviewer roles, nudges, disclosure and data-subject rights. Staff cannot downgrade age protection via a classroom setting. Districts may impose stricter rules.

## Additional legal reviews

- State student-privacy and bullying requirements (e.g., Michigan) may provide shorter access response periods, breach notifications, data processor contract terms, reporting requirements or restrictions on biometric analysis.
- PPRA needs separate review if a feature becomes psychological assessment or a sensitive student survey rather than ordinary safety screening; avoid AI diagnoses and hidden behavioral dossiers.
- IDEA/Section 504, Title VI/IX, mandatory child-protection reporting, accessibility obligations and district retention schedules may matter by incident type. Use safeguarding/civil-rights specialists, not classifier labels, for decisions.
- Public-school student speech rights constrain off-campus action. See [Mahanoy Area School District v. B.L.](https://www.supremecourt.gov/opinions/20pdf/20-1083_1b7d.pdf) and [external evidence policy](external-evidence.md). Validate case citation/version with counsel.

## Records system requirements

Each retained record: source/purpose, student rights linkage, authorship versus inference, provenance, age band, tenant and scope, access policy, independent disclosure trail, review/correction/retraction history, expiry and hold state. Support export and multi-student review with legally assessed redaction. **An unsubstantiated hypothesis is not a verified finding** and should be marked as such in any legally required inspection.

## Go/no-go questions for pilot

- Is every source an authorized school activity? Have student/parent notices and necessary consents been reviewed?
- Can a reviewer access other students' messages without appropriate need and approval? If yes: no-go.
- Can an under-13 message reach any non-approved model, analytics sink, error log or support tool? If yes: no-go.
- Can the district respond to an access/correction/deletion request, including graph derivatives and legal holds? If no: no-go.
- Has a human safeguarding team approved emergency response, appeal and no-auto-discipline policy? If no: no-go.

Primary sources: [FERPA regulations](https://studentprivacy.ed.gov/ferpa), [ED legal basics](https://studentprivacy.ed.gov/legal-basics), [ED school-official guidance](https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa), [FTC COPPA FAQs](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions), and [2025 COPPA rule text](https://www.govinfo.gov/content/pkg/FR-2025-04-22/html/2025-05904.htm). These rules need re-verification at deployment time.
