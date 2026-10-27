# Multistage moderation and provider architecture

**Status: proposed additions, not current API capabilities.** Existing evaluation is request-scoped; no graph or external provider adapter besides Clef ships today.

## Problem

Single-message toxicity is not a proxy for bullying. Harassment can consist of innocuous-seeming repeated messages, deliberate exclusion from required groups, report brigading, the forwarding of humiliating rumors, or misuse of delegated mute powers. Conversely, profane banter, literary quotations, disagreement, a victim reporting abuse, and a student setting a private contact boundary may be benign. [Session-based cyberbullying research](https://arxiv.org/abs/2207.10639) emphasizes repetition and context.

Design objective: **high recall for safety-critical events, low false intervention rates, low per-message inference cost, minimized collection, and timely student protection**. There is no substitute for human safeguarding review for high-stakes cases.

## Processing stages

| Stage | Input | Method | Output and persistence |
|---|---|---|---|
| L0: content and event hygiene | Authorized text, image, mentions, membership/permission events | MIME validation, spam counters, exact/near-duplicate detection, role checks, contact-boundary rules | Stateless decision or short-lived bounded signal; do not send ordinary interaction graph to AI |
| L1: standard content hazards | Candidate text/image with minimal relevant context | Existing Clef; optionally independently approved OpenAI Moderation or Meta Llama Guard | Scoped classification evidence, source/model/policy version; no default raw-content retention |
| L1b: contextual Nouls | Ambiguous school conduct | Clef or an approved typed-decision provider | Speech acts and reference uncertainty; not a finding of bullying |
| L2: temporal correlation | Relevant, authorized safety signals and source references | Distinct days, role/permission history, unique conversations, repetition, evidence provenance; initially deterministic graph features | Expiring incident candidate or human-review request |
| L3: precision investigation | Higher-risk or contradictory candidate | Additional model if approved plus appropriately authorized human | Reviewable case finding, safeguarding action and appeal |
| Intervention | Decision and minimal authorized principal token | Deterministic policy and product UI | Allow, private nudge, friction, hold, protective restriction, human escalation |

Sample harmless messages and previously missed cases within an approved, privacy-minimized evaluation program. Do not rely solely on L0 triggers or sophisticated coercion will systematically evade detection. Sampling real children's communications also requires its own legal justification; synthetic evaluation alone is the default during development.

### Real-time versus async

The message delivery path should perform deterministic checks and selected short-timeout classifier calls under an explicit latency budget. Time-intensive cross-message correlation occurs out-of-band only on retained, purpose-justified signals. An urgent credible threat goes immediately to safeguarding; it must not wait for graph aggregation or a batch job.

Never claim the current Worker implements these stages. The current HTTP API supports individual/batch evaluations and capabilities/receipts but has **no** incident event ingestion, nudge execution, identity mapping or case review endpoints.

## OpenAI and Meta relationship

| Capability | Purpose | Limits |
|---|---|---|
| [OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation) | Baseline fixed-category content screening. The published taxonomy currently exposes 13 categories and text/image input, with modality flags per category. | Harassment, hate, illicit and sexual/minors are text-only categories; image scores of zero for unsupported categories must not be treated as evidence of image safety. Not a CSAM detector. |
| [Meta Llama Guard 4](https://huggingface.co/meta-llama/Llama-Guard-4-12B) | Optional independent, locally deployable text/image hazard classifier and taxonomy reference. | Model license, hardware, language performance and multimodal limits must be validated. Defamation label does not prove a rumor is false; not a school social graph. |
| [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) | Typed contextual Noul, score and choice decisions and supported image classification. | Custom definitions are uncalibrated until tested; price, limits and question schema are model/version dependent. |
| [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) | Potential alternative provider for typed application decisions. | Separate contract, under-13/ZDR eligibility, caching and latency verification. Not currently integrated. |
| Social event correlation | Detects repeated exclusion, report manipulation, access abuse and campaign behavior | Our responsibility to implement; cannot be inferred reliably from a standalone safety label. |

Meta's *product* practices (private friction, Restrict/Hidden Words, reporting) are design references; the open Llama Guard weights are **not** Meta's full Instagram enforcement system.

### Canonical result

Use a provider-independent envelope that includes decision ID and revision, modality, per-class scores, provider/model version, score calibration version, whether enough context was available, uncertainty, refusal/missing category state, and privacy-policy route. **Do not silently infer zero risk from absent, unsupported or errored scores.** Retain only under authorized ephemeral or case storage, never in current content-free receipts.

### Routing logic and economics

Rules that do not require inference (message rate limits, exact duplicate hashes, role-authority checks, user contact boundaries) remain deterministic. Feed borderline semantic content to Clef-flash; optionally escalate difficult cases to Clef or independent classifier. Route only approved, necessary context. Do **not** automatically replicate student content to OpenAI, Meta or AI Gateway for consensus.

Budget formula, for planning only:

    model_input_cost = messages * routed_fraction * input_tokens_per_routed * price_per_million / 1_000_000
    end_to_end_cost = model_cost + retries + storage + queues + security + operations + human_review

Example assumptions: 1M messages, 15% routed, 600 input tokens per routed message => 90M billed input tokens (excluding image tokens/retries); at $0.038/M Clef-flash input tokens, $3.42 of model input charges. Pricing is a **dated illustrative assumption, not a quote, production forecast or SLA**; check [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before budgeting. Never select a model solely by cost. Model accuracy, data exposure, allowable purpose, throughput, false-positive cost and staff workloads usually dominate.

## Failure and abuse handling

- Missing/malformed classifier response: mark unavailable/unknown. Current student profiles fail closed; don't change their floors via policy overlay without review.
- Escalation exhausted: use authorized human triage or safe, minimally disruptive product flow; never turn unknown into “safe.”
- Missing under-13 provider approval or ZDR: reject outbound transfer before inference; use approved local route or human review.
- Suspected CSAM: avoid passing images to a generic moderation endpoint; use dedicated legally reviewed detection, preservation, reporting and support procedures.
- Messages from a student disclosing distress: supportive handling must not be downgraded to spam/harassment solely due to disturbing text.
- Never let report count alone issue sanctions or unmask a student.
- Prevent adversarial content within evidence from changing model instructions; Nouls and policy originate only from signed registry configuration.

## Implementation boundary

Extend APIs via a **separate versioned safety-events/cases service**, authenticated and tenant-scoped, with rate limits, dedicated evidence storage and access controls. Do not add raw evidence to existing receipts, logger, tracing or cost ledger. Reference [incident graph](incident-graph.md), [decision definitions](semantic-registry.md), [privacy](../privacy/ferpa-coppa.md), and [rollout](../validation-and-rollout.md).
