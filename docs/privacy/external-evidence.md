# External evidence, social-media reports and narrowly scoped OSINT

**Status: proposed optional module; NOT currently shipped and NOT enabled by default.** Intended primarily for high-school incident investigations. Collection from social media is a separate legal/policy decision, not a consequence of enabling EducateOS chat moderation.

## Why external evidence matters

Harassment may cross boundaries: a student reports a humiliating public meme, classmates forward it into a school-managed chat, and permission removals in a required project follow. The case team should be able to preserve relevant, lawful evidence **without running a continuous crawler of minors' social lives**. Cross-platform identity resolution is error-prone; a matching username, photo, nickname, shared device or location cannot conclusively identify a student.

School action involving off-campus speech must respect [Mahanoy Area School District v. B.L. (U.S. Supreme Court, 2021)](https://www.supremecourt.gov/docket/docketfiles/html/public/20-255.html). The decision notes that serious bullying/harassment or threats may implicate substantial school interests but does not give blanket authority to police students' off-campus speech. District counsel should review scope and evidence for a particular case.

## Explicit source modes

| Mode | Collection trigger and scope | Default |
|---|---|---|
| Student/parent/staff submission | A person voluntarily submits URL, screenshot, media or description tied to a safety concern | Allowed only with intake, notices, evidence and retention safeguards |
| Case-scoped public research | A **named, authorized case investigator** reviews specific lawfully accessible public content relevant to a documented incident | Disabled until district and counsel approve |
| Narrow public school threat awareness | Separate policy for public threats against facilities/events, with trained threat-assessment owners and strict search scopes | Separate optional safety program, not student behavioral OSINT |
| General schoolwide social listening | Crawl students' posts/followers, infer friendships/sentiment, identify hidden accounts, collect private DMs | **Prohibited default / out of scope** |
| Private-account access | Circumvent privacy settings, use fake accounts, scrape closed groups or demand student passwords | **Out of scope** |

Official Instagram, TikTok, YouTube, Discord and Snapchat APIs vary in access, rate limits, age rules, permissions and data availability. Do **not** design assuming general access to private or minors' conversations. Student-submitted evidence is a more realistic early feature. Verify current API terms and data-processing authority for each connector before implementation.

## Intake and evidence provenance

A report should separate these concepts:

- **Reporter statement:** what they observed, when, their requested help, whether they are directly affected. Do not treat the reporter as a rumor participant merely for providing evidence.
- **Source record:** original URL/platform, capture timestamp, uploader authority, visibility (public, school-owned, volunteered), integrity hash, capture method and chain-of-custody information.
- **Content:** store only relevant excerpts/media in restricted incident storage, with explicit purpose/TTL and removal when unnecessary.
- **Unverified attribution:** alleged author, alleged target, candidate identities, uncertainty, known contradictory information.
- **Automated classification:** supported modality, calibrated category score, model/version, abstention, language and confidence limitations.
- **Human adjudication:** what the authorized reviewer actually corroborated, decisions, appeal/correction, disclosure, preservation.
- **Legal basis:** school relevance and any FERPA/COPPA/state speech or privacy restrictions; mandatory reporting and urgent pathways handled separately.

Photos and screenshots can be cropped, faked, stale or missing preceding context. Record such limitations and never label a student guilty from one screenshot or similarity search. Synthetic-media detection scores alone don't prove manipulation or authenticity.

## Handling dangerous evidence

- Suspected CSAM: do **not** submit it to the generic OpenAI Moderation endpoint, to arbitrary classifiers, a public file host or a teacher-wide queue. Implement vetted specialized detection, minimal controlled handling, preservation/reporting obligations and a designated child-safety response.
- Credible imminent threats, extortion and self-harm disclosures: use trained human triage and emergency policy immediately; do not wait for point aggregation, generic classifier consensus or regular case approvals.
- Avoid gratuitous redistribution of humiliating material to reviewers; supply a description/blurred preview where appropriate and expose source evidence only under approved case access.
- Collect nothing from students' own social accounts merely to build a baseline of “who talks about whom.” Prevent cross-tenant and cross-school correlation.
- Account for security of URLs and untrusted media: safe URL parsing, content type/size verification, malware scanning/isolated preview, anti-SSRF allowlists and no direct remote image fetch through the current Hall Monitor API (it expects embedded images).

## Proposed integration boundary

- A distinct /external-evidence service authenticates reporter or investigator and records purpose, source and access rights.
- It stores only case-relevant evidence in separately encrypted, district-owned storage, not Hall Monitor evaluation receipts or common logs.
- An evidence pointer plus minimized, authorized excerpt may be evaluated using the existing scoped Hall Monitor /v1/evaluations API when classification is approved.
- Any link between an external account and a district student is a **proposed inference** requiring independent verification and restricted authorization; no automatic identity disclosure or sanction.
- Case conclusions and retention are controlled by designated safeguarding and records staff, with records-access and deletion/holds workflow.
- Provide students safe reporting, appeal and anti-retaliation options.

## Before enabling

Require an approved source inventory; provider/API terms; assessment of monitoring necessity and proportionality; district policy and parent/student notices; identity-attribution and evidence-authenticity tests; secure intake; approved case-scoped retention; off-campus student speech review; mandatory reporting protocol; access/appeal/export plan; and actual security testing. Ordinary K–8 deployments should leave automated external OSINT disabled; submitted reports still require safeguards.

See [incident graph](../design/incident-graph.md), [student protections](../design/behavior-and-interventions.md), and [FERPA/COPPA](ferpa-coppa.md).
