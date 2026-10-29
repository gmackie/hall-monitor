# Read-only privacy preflight and governed model routes

HM-24 · W4/W5 source implementation · **No real enrollment or provider approval supplied**

`packages/governance` and `scripts/privacy-preflight.ts` separate server enrollment, signed source
eligibility, operator-installed configuration evidence and the decision immediately before a
model call. The public evaluation request schema is unchanged. A grade band is never an age or
permission assertion. The [pilot charter](../launch/pilot-charter.md) and
[custody decision](record-custody-decision.md) remain the human entry gates.

## Preflight

Supply an operator-controlled JSON file with `enrollment`, `verifierRef`, `evidenceExpiresAt` and
`providerRetention`. Enrollment uses the strict schema exported from governance: institution,
accepted issuers, product/surfaces, purpose-to-evaluation-kind mappings, data classes/age eligibility,
policy/approval/agreement references, explicit approval interval, maximum eligibility age,
revocation and exact account/Worker/source-revision/direct-or-Gateway/model route. No default
approval or evidence lifetime is invented. References identify human decisions; their presence is
not a signature check or legal approval by this tool.

```sh
# Default: offline, no network, cannot produce verified settings.
pnpm privacy-preflight --approval /private/operator-approval.json --out dist/privacy-dryrun.json --dry-run

# Explicit inspection: GET settings only, existing scoped credential in the process environment.
pnpm privacy-preflight --approval /private/operator-approval.json --out dist/privacy-evidence.json --inspect --read-only
```

The inspection credential is `CLOUDFLARE_API_TOKEN`, supplied privately by the operator. It is
used only in the Authorization header to Cloudflare's fixed API origin, never included in reports.
The tool performs no inference, config repair, token creation, log search or storage deletion.
Exit 0 means the scoped configuration evidence matched; 2 means denied/unverified/invalid inputs,
and 1 means local input/output failure. Reports use mode 0600 and fixed result/reason codes.

The typed Cloudflare adapter reads:

- `GET /accounts/{id}/workers/scripts/{name}/settings`: observability/logs/traces/tail consumers,
  Worker Logpush, AI binding, `FG_COMMIT_HASH` and route-binding visibility.
- `GET /accounts/{id}/logpush/jobs`: the single-page account job inventory, assessed separately
  from Gateway logging. Any enabled job is conservatively denied; destinations/keys are not copied.
- For a Gateway route, `GET /accounts/{id}/ai-gateway/gateways/{id}`: whole-log collection,
  Gateway Logpush and cache TTL, independently checked.

Field/path references were checked against Cloudflare's public Python SDK `ai_gateway`,
`workers/scripts/script_and_version_settings` and `logpush/jobs` resources on 2026-10-29.
Only explicitly disabled settings pass this strict profile. Missing fields, denied permissions,
unknown cache TTL, network errors and unreadable secrets remain unverified. In particular a
secret `HM_AI_GATEWAY_ID` cannot be read back through settings, so its actual value cannot be
attested by this adapter. Direct Workers AI is the initial inspectable route when the binding is
absent. No request header substitutes for account/export/configuration evidence.

Provider-internal retention, model-specific cache/retention exceptions, agreements and data/age
eligibility still require the responsible human owner and external evidence. The `modelRetention`
observation records that declared review. This tool does not certify ZDR, physical erasure,
FERPA/COPPA compliance, backup deletion, code secrecy or a provider's complete infrastructure.
The current repository enables Worker observability: that does not pass this stricter profile
without a separately approved configuration change. Nothing here makes such a change.

## Server enrollment and source contract

`HM_GOVERNANCE` is strict JSON `{schemaVersion:"1.0", tenants:{...}, evidence:{...}}`, installed
as a secret by an authorized operator. Evidence is keyed by tenant and must match institution,
policy, approval, agreement, route, data class and eligibility. A malformed explicit setting denies
all model transfers and reports `governanceConfig:false` in authenticated readiness. Missing
configuration means no new enrollment; unenrolled tenants retain existing behavior. The readiness
check validates configuration shape, not a human sign-off or every per-request authorization.
Governed enrollments always enforce decisions, including synthetic enrollments. Existing shadow
overrides cannot convert a denied hold into allow. Malformed governance also forces enforcement.
Use the offline evaluation harness for shadow comparisons of a governed candidate.

An enrolled source must place a strict `hm_governance` extension in its existing service JWT:

```text
schemaVersion, institutionId, requestId, product, surface, purpose, dataClass,
ageEligibility, eligibilityRef, policyRevision, issuedAt, expiresAt
```

The existing trusted signature, audience, tenant, expiry and one-use token guard still apply.
Eligibility expiry cannot outlive the token. The request ID, product, surface, purpose/kind and
institution must match the enrolled source and request. Unknown/ineligible ages, expired/future
claims and inconsistent synthetic/staff eligibility are denied. The extension carries no student
identity, birth date or text. A batch token can authorize only its matching request ID; broader
batch eligibility requires a separately designed signed contract rather than a permissive fallback.

Source integration must attest eligibility from its authoritative access and records systems,
not copy browser claims. That integration and institutional authority are separately gated work.
The Worker proves what the trusted source asserted, not whether its underlying records are true.
Do not enroll a real source until its guard and human approvals exist.

Enrolled deployments also require operator-verified `HM_GOVERNANCE_ACCOUNT_ID`,
`HM_GOVERNANCE_WORKER_NAME` and ForgeGraph's deployed `FG_COMMIT_HASH`, matching inspected evidence.
These are trusted deployment identity pins; the platform does not remotely attest them to this
library. Source/config revision changes require fresh evidence. The deploy helper forwards the
optional governance settings; it sets no production value and never mints an approval.

## Transfer, revocation and failure behavior

The server checks the initial route before constructing a classifier. Clef's optional
`authorizeModel` hook then rechecks immediately before each primary or escalation call, using
the current time. A denied transfer records no provider attempt or fictional charge. Denied
primary classification uses existing unavailable/fail-closed policy; denied escalation retains
the authorized primary result with uncertainty and no alternate-provider call. Actual provider
failures retain the existing unknown-cost attempt behavior.

Governed Gateway calls explicitly request whole-log suppression and cache bypass, in addition
to existing payload suppression. These request controls supplement the inspected configuration.
There is no fallback to an unapproved account, model or provider. Fixed denial codes contain no
content, eligibility references or personal data. Deterministic distress support remains available.

Revocation is operator-controlled config delivery: set the tenant's `revoked` flag or withdraw
evidence and deploy the secret through the approved channel. Each new evaluation sees the
updated setting; each transfer rechecks the in-flight request's configuration snapshot and clock.
An already running provider request cannot be recalled, and changing a secret does not push into
an existing request's snapshot. Use the source stop/withdrawal mechanism as part of urgent response.
This is not an instantaneous global revocation service. Rerun preflight after deployment or route,
logging, export, cache, agreement or approval change; expired evidence denies automatically.

## Evidence and remaining gates

Synthetic tests cover fresh admission, wrong/forged issuer and tenant, missing/body-supplied
eligibility, wrong request/purpose/account/route, stale/revoked evidence, primary and escalation
denial, preserved distress support, no invented charges, metadata leakage and GET-only inspection.
The existing full suite, standalone rollback, both Worker bundles and public-package packing
remain required gates. Tests and fake API responses are not actual cloud inspection evidence.

Live preflight and source acceptance remain open: approved host/source, accountable agreements,
retention/privacy/security owners, actual account permissions and configuration evidence,
source-side eligibility, target deployment and authenticated default-off acceptance. HM-24 stays
open until these required production obligations are met. No new tenant, provider, threshold,
data class or school profile is enabled by this implementation.
