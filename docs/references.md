# Evidence and source register

Last checked **2026-10-27**. This register distinguishes **primary vendor/regulatory specifications** from **research informing architectural hypotheses**. Vendor behavior, pricing, statutes and platform API conditions change; revisit them before every release/pilot and record the check date in the release's evidence pack. Inclusion does not imply validation of Hall Monitor's proposed system.

## Primary specification and provider sources

- [Cloudflare Clef model/API and question schema](https://developers.cloudflare.com/workers-ai/models/clef/) — available typed decisions, image limits, model pricing/limits. The existing code currently uses Clef-flash and Clef.
- [Cloudflare Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) — stateless ZDR/no-training commitments, stateful features, metadata and exceptions (updated 2026-10-16).
- [Cloudflare AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) — default-on logs and per-request content controls.
- [Cloudflare AI Gateway Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/) — exports unaffected by per-request logging headers.
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) — current model-specific costs; all document examples are dated illustrative budgets.
- [OpenAI Moderation guide and category/modality matrix](https://developers.openai.com/api/docs/guides/moderation) — fixed hazard categories; harassment/hate text-only; not for known/suspected CSAM.
- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions) — optional future typed-decision provider; no integration assumed.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) — ZDR approval, endpoint matrix, prompt-cache/image exceptions and project modes.
- [OpenAI under-18 developer guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance) — ZDR before processing personal information of under-13 children.
- [OpenAI ZDR with Private Safety Processing](https://developers.openai.com/api/docs/guides/private-safety-processing) — approved safety-review architecture and 30-day customer storage obligation.
- [OpenAI project retention status](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/data_retention/methods/retrieve) and [organization retention status](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/data_retention/methods/retrieve) — configuration checks, not cryptographic proof.
- [Meta Llama Guard 4 model card](https://huggingface.co/meta-llama/Llama-Guard-4-12B) — model restrictions and MLCommons-derived hazard taxonomy; not Meta's full moderation product.
- [Meta bullying/harassment Community Standards](https://transparency.meta.com/policies/community-standards/bullying-harassment/) — platform policy context and enforcement distinctions.

## Government and legal primary sources

- [U.S. Department of Education: FERPA regulations](https://studentprivacy.ed.gov/ferpa) — definition, school-official exception, education-record access and emergency disclosures.
- [ED: Legal basics](https://studentprivacy.ed.gov/legal-basics) — parent access (45 days), amendment, disclosure rights.
- [ED: School-official exception](https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa) — contractors, direct control and legitimate interest.
- [ED: Records of multiple students, including photos/videos](https://studentprivacy.ed.gov/faq/faqs-photos-and-videos-under-ferpa) — inspection and redaction limits.
- [FTC: COPPA FAQs and school-consent guidance](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions) — school benefit/no other commercial purpose and limits.
- [FTC: COPPA final changes (2025)](https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data) — final changes and non-adoption of proposed education-specific changes.
- [Federal Register: amended COPPA Rule](https://www.govinfo.gov/content/pkg/FR-2025-04-22/html/2025-05904.htm) — effective date June 23, 2025; most compliance by April 22, 2026.
- [U.S. Supreme Court: Mahanoy Area School District v. B.L., docket 20-255](https://www.supremecourt.gov/docket/docketfiles/html/public/20-255.html) — limits/nuance of off-campus student speech regulation.
- [StopBullying.gov: What is bullying?](https://www.stopbullying.gov/bullying/what-is-bullying) — repetition and real/perceived power imbalance as conceptual definitions, not single-message AI labels.

## Research motivating *tests*, not proof of performance here

- [Ge, Cheng & Liu — Improving Cyberbullying Detection with User Interaction (WWW 2021)](https://arxiv.org/abs/2011.00449) — temporal graphs and topical correlations for contextual bullying.
- [Yi & Zubiaga — Session-based Cyberbullying Detection in Social Media: A Survey (2022)](https://arxiv.org/abs/2207.10639) — conversation-level modeling, dataset construction and evaluation challenges.
- [Zhan et al. — SLM-Mod: Small Language Models Surpass LLMs at Content Moderation (NAACL 2025)](https://aclanthology.org/2025.naacl-long.441/) — smaller tuned models can outperform zero-shot LLMs for community-specific moderation; not a validated school-wide finding.
- [TGBully reference implementation](https://github.com/gesy17/TGBully) — example temporal interaction model, not a drop-in student safety system.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) — provenance vocabulary applicable to evidence and inferred claims.

## Temporal moderation and infrastructure research (checked 2026-10-28)

- [Gaggle 2021–22 Student Safety Report, PDF p.11](https://images.g2crowd.com/uploads/attachment/file/1288126/Through-the-Gaggle-Lens---The-State-of-Student-Safety---2021-22---REPORT.pdf) — vendor incident weekday shares and 65% school-day / 35% after-hours. Not U.S.-representative harm prevalence.
- [Thulin et al., Injury Prevention 2026 / PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13430530/) — 44,998 NC youth safety tips by time/day, category and urgency. Reporting timestamps are not incident-occurrence timestamps.
- [Gaggle 2024–25 annual report](https://news.gaggle.net/student-safety-report-2025) — nearly 6.9B content items and >8.7M human-reviewed, 482,203 district alerts, 26,855 emergency calls; rounded vendor funnel.
- [Gaggle 2025–26 report](https://news.gaggle.net/2026-ssr) — more recent findings and commissioned Friday Institute evaluation; 3 of 355 safe items falsely flagged in two earlier evaluation runs; final run did not include safe items.
- [Reddit July–December 2025 transparency report](https://redditinc.com/policies/transparency-report-july-to-december-2025-reddit) — global removal and moderator automation share, not hourly U.S. student moderation.
- [Cheng et al. 2017, Anyone Can Become a Troll](https://pmc.ncbi.nlm.nih.gov/articles/PMC5791909/) — context, mood and time effects; historical CNN discussion sample, not a modern national clock curve.
- [Cloudflare Workers Analytics Engine SQL](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) and [sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) — sample-weighted aggregate estimation, not exact case counts.
- [Cloudflare Workers Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) — three-month retention and write limits; district policy may require shorter-lived alternative.

## Revalidation checklist

Review: live API/model availability; provider eligibility and age terms; actual model input modalities and unsupported categories; data-control and caching exceptions; price/limit changes; rule revisions and school privacy interpretation; external platform data access; latest research/evaluation evidence. Save source, verification date and responsible human in the rollout evidence pack. Avoid treating academic benchmark scores as school pilot results.
