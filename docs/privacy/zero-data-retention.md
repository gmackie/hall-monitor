# Zero Data Retention (ZDR) and enforceable model routing

**Research/design snapshot: 2026-10-27.** This is a vendor- and feature-specific statement of known commitments, exceptions, unverified settings and proposed controls. “ZDR” is **not** proof that plaintext never reaches a provider, that transient processing doesn't occur, or that a provider's internal systems have cryptographically erased every copy.

## Four distinct claims

| Claim | Meaning | Practical assurance |
|---|---|---|
| No training | Customer content won't train models | Contract and terms; not the same as no retention |
| No standard prompt/response logging | No ordinary abuse/payload logs beyond listed exceptions | Vendor retention terms, audits, configured routing |
| No persistent application state | No saved conversations/files/cache except listed limitations | Verify endpoint, request mode, cache, tool use and integrations |
| No remote plaintext processing | Provider cannot view content in active inference | **Not** guaranteed by ordinary hosted ZDR; requires different trusted-computing design |

**Hall Monitor's own evidence storage is separate**: a district may lawfully retain specific incident evidence under its record schedule while requiring provider inference to be stateless. Conversely, a provider ZDR claim does not erase district-side messages, logs, R2, Durable Objects, KV, Vectorize, tracing or backups.

## OpenAI API

Reference: [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data), [under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance).

- ZDR is approval-based, not a default setting on a paid API project. Verify organizational **and project** modes and provider-approved data processing terms.
- [OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation) has no ordinary abuse-monitoring or application-state retention according to the current endpoint matrix, but **do not infer default moderation routing satisfies the explicit under-13 requirement**: obtain configured and approved ZDR before sending their personal data.
- The Decisions endpoint is ZDR-eligible, but default abuse-log policy and feature-specific caching must be reviewed. OpenAI documents GPU-local encrypted attention-cache/key-value tensors for some Decisions workloads with up-to-24-hour expiration.
- For Responses/Chat Completions, ZDR ordinarily treats store=true as false; not every tool/feature is ZDR-eligible. Files, background, third-party MCP/tools, audio, images, extended caching and certain model capabilities have separate storage/retention conditions.
- Safety/legal exceptions: suspected CSAM image/file data may be retained for human safety review even under ZDR; OpenAI also documents exceptional model/customer safety-retention processes. **Do not send known or suspected CSAM to the generic moderation API.**
- [Private Safety Processing (PSP)](https://developers.openai.com/api/docs/guides/private-safety-processing) is a separate ZDR safety-review mode: selected records are encrypted into **customer-controlled storage** and require approximately **30 days minimum customer retention**. PSP attested review does not prove ordinary base-model inference is all attested. Customer storage is not “zero storage,” and PSP mode requires separate review for school-record retention and deletion obligations.
- Metadata and contractual/safety exceptions still exist. ZDR is not a FERPA/COPPA certification.

### Programmatic control check

An administrator, not an inference Worker, can query:

- [GET /v1/organization/data_retention](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/data_retention/methods/retrieve)
- [GET /v1/organization/projects/{project_id}/data_retention](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/data_retention/methods/retrieve)

Check the project-specific mode; when “organization_default”, resolve the org mode. Distinguish zero_data_retention, enhanced_zero_data_retention, modified_abuse_monitoring, enhanced_modified_abuse_monitoring, none and any separately validated PSP project mode. **An API response confirms the provider's declared configuration, not physical erasure**. Require an explicit allowlist for endpoint, model, features and jurisdiction; cache the verified status with a short expiry; fail closed if it becomes stale or incompatible; use a tightly scoped project inference credential. Never expose admin key to the Worker.

An illustrative deployment check, to be adapted to approved modes:

~~~sh
# Authorized admin environment only. This is NOT runtime code.
curl --fail-with-body -sS \
  "https://api.openai.com/v1/organization/data_retention" \
  -H "Authorization: Bearer $OPENAI_ADMIN_KEY"
curl --fail-with-body -sS \
  "https://api.openai.com/v1/organization/projects/$OPENAI_PROJECT_ID/data_retention" \
  -H "Authorization: Bearer $OPENAI_ADMIN_KEY"
# Parse the JSON type fields; resolve organization_default.
# Fail pipeline when an allowlisted mode or agreement is absent.
~~~

An admin check is insufficient without contract/eligibility validation, image exceptions, and routine rechecks.

## Cloudflare Workers AI

Primary: [Workers AI Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), updated October 16, 2026.

- For ordinary **stateless** Workers AI requests, Cloudflare says customer inputs/outputs are used only as needed for service and not retained after processing, subject to limited legal/safety exceptions.
- Cloudflare states no training of Workers AI models on Customer Content. Operational metadata can be retained.
- R2, KV, Durable Objects, Vectorize, asynchronous/batch processing, adapters, user application logs and Gateway caching/logging are separate **stateful** features governed by their own controls.
- Routing through Gateway to a third-party model invokes **that provider's** retention terms too. Cloudflare Workers AI's data-use commitment doesn't impose ZDR on external providers.

**Direct Workers AI binding** is preferable as a starting point for district-controlled Clef inference because it avoids a separate gateway logging and export surface—**not because it provides an absolute security proof**.

## Cloudflare AI Gateway: traps we need to close

Sources: [Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/), [Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/).

- Gateway logs are **enabled by default** and may contain prompt/response bodies.
- Per request “cf-aig-collect-log: false” prevents the ordinary saved Gateway log; “cf-aig-collect-log-payload: false” logs metadata but omits payload. Default gateway logging should also be disabled for sensitive student streams.
- **Logpush exports are independent** of those headers; logging off does *not* disable enabled Logpush jobs or their destination storage. Inspect at account/gateway/export-destination level.
- Confirm caching off and explicitly bypass cache on student requests; inspect retries, routing, gateway guardrails, DLP and any prompt-prefix/model cache separately. Note that gateway payload logging controls do **not** govern Worker observability or third-party telemetry.
- Current code packages/clef/src/transport.ts defaults to the **payload** header false when using Gateway. This is not equivalent to disabling all logs, Logpush, or response caching. Current launch gate P3 checks payload logging only and is **insufficient** for the proposed strict privacy profile.
- Configure Worker console/logpush/error-tracing/Sentry-like tooling separately; content-free app logger design does not prove the infrastructure cannot emit bodies by other paths.

## Analytics Engine is not a zero-retention inference path

Cloudflare [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) currently say data are stored **for three months**. This is a separate analytic storage product, not covered by the inference-only Workers AI stateless ZDR claim. Hall Monitor temporal analytics must never send raw student text, images or personal/case identifiers there; even content-free small-cohort metrics can be identifying. If the approved school retention schedule requires a shorter time, do not use Analytics Engine for that stream. Use a district-owned TTL-governed alternative and verify expiry, exports and backup behavior.

## Assurance hierarchy and verification plan

1. **Signed commitments:** DPA, subprocessor list, age/region eligibility, customer content definition, data-use limits, training bans, deletion/retention schedule, special exceptions, notice of changes, audit rights.
2. **Independent evidence:** assess actual SOC 2/security report coverage and compensating controls, not a logo.
3. **Configuration evidence:** provider retention mode, model/endpoints, log settings, Gateway exports, caching, storage buckets, project bindings and change tracking. Automate preflight and scheduled drift checks.
4. **Synthetic trace test:** send a sentinel value to a synthetic account, inspect our own logs, Gateway logs/Logpush, destinations, traces, error reports, caches and backups for leaks. A clean test says **only** our observed surfaces did not retain it, not that vendor internals are clean.
5. **Optional confidential computing:** remote attestation can verify measured runtime when offered, but cannot alone prove no exfiltration, no side channels or that all paths are protected.
6. **Fail-closed route:** if approval, config freshness, transport, model availability, legal basis or residency cannot be verified, do not send identifiable student data. Use an allowed local classifier or human safeguarding path; do not fail open via another provider.

### Proposed Governance Gate inputs

~~~ts
type GovernanceDecision = {
  tenantId: string;
  requestedPurpose: "classroom_moderation" | "case_review";
  ageBand: "under13" | "minor13plus" | "adult_or_unknown";
  dataClass: "synthetic" | "school_internal" | "student_pii" | "safety_evidence";
  modality: "text" | "image" | "audio" | "video";
  provider: string;
  projectId: string;
  endpoint: string;
  model: string;
  approvedAgreementRevision: string;
  observedRetentionMode: string;
  verifiedAt: string;
  cacheDisabled: boolean;
  logPayloadDisabled: boolean;
  logpushDisabled: boolean;
  policyRevision: string;
  authorized: boolean;
  denyReason?: string;
};
~~~

This type is a **proposed decision record**, not a currently implemented contract. Avoid storing exact student identity, plaintext message or evidence in the governance audit log; still protect metadata and tenant IDs appropriately.

## Privacy regression tests before student launch

- Under-13 identifiable content to non-approved OpenAI project: refused with no HTTP request to provider.
- Under-13 message routed through “fallback” non-ZDR provider: refused; safe local/human route used.
- Project mode changed from zero_data_retention to none: freshness check blocks requests.
- Gateway dashboard log on / per-request flag absent / Logpush enabled: strict policy refuses route.
- A failed model call does not log raw error/request/response content.
- Student request cannot opt into stored tool, response, embedding, or cached state without explicit governed purpose.
- Image classification never sends suspected CSAM to generic moderation provider and follows the safeguarding/reporting process.
- Student case evidence has separate, lawful retention and deletion testing; provider ZDR is not substituted for district record handling.

## Current code versus proposed gaps

Current source: content-free Worker logging; digest-based idempotency; content-free receipt storage
with configurable retention; Clef sends images/text without storing them as receipts; optional
Gateway transport explicitly disables payload logging; test fixtures are synthetic.
[W4/W5](preflight-evidence.md) adds a read-only configuration preflight and opt-in server enrollment
with signed eligibility and per-call route checks. Real cloud evidence, source acceptance, human
approvals and production delivery remain open. No actual enrollment or ZDR certification is supplied.

Not yet verified/implemented here: account-wide Gateway logs off, Logpush disablement, caching enforcement, OpenAI project ZDR attestation, cross-provider Governance Gate, continuous configuration drift monitoring, district contracts, actual Student PII processor review and school-specific data-erasure service.

**No student rollout merely on this documentation.** Review [launch gate additions](../launch/launch-checklist.md) and [FERPA/COPPA](ferpa-coppa.md) before any identifiable learner payload is sent.
