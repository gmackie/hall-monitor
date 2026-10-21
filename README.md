# Hall Monitor

Product-neutral moderation and evaluation service shared by SchoolOS and PlayTrek.

Hall Monitor answers one question: *is this content or requested activity appropriate for this
product, role, curriculum context and institutional policy, and what should happen next?* It
returns findings and a decision (`allow`, `coach`, `hold`, `block`, `support`) plus a content-free
cost receipt. It never authorizes access to student data, impersonates a teacher, or awards grades.

## Layout

| Package | Purpose |
|---|---|
| `packages/contracts` | Versioned wire schemas: evaluation requests and results, findings, receipts, errors |
| `packages/costing` | Integer `UsdNano` arithmetic, immutable price books, receipts and scenario calculator |
| `packages/policy` | Policy profiles, district floors and the deterministic decision resolver |
| `packages/evaluators` | Deterministic evaluator plugins |
| `packages/clef` | Cloudflare Workers AI Clef classifier adapter with escalation |
| `packages/core` | Evaluation orchestration |
| `packages/client` | TypeScript client used by products |
| `packages/test-fixtures` | Synthetic fixtures only; never real student data |
| `apps/worker` | Cloudflare Worker HTTP API |

## Rules

- No product code: shared packages never import `@playtrek/*`, `@schoolos/*` or `@gadgets/*`
  (`pnpm check:boundaries`).
- No raw content in receipts, logs or metrics. Money is integer nanodollars (10⁻⁹ USD), never floats.
- Fixtures are synthetic.

## Worker API

`apps/worker` serves the HTTP API (do not deploy without owner approval):

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/evaluations` | `evaluate` scope | Evaluate one request; idempotent by `idempotencyKey` |
| `POST /v1/evaluations:batch` | `evaluate` scope | Up to 50 `content.candidate` / `assessment.evaluator-result` requests |
| `GET /v1/capabilities` | any valid token | Supported versions, kinds, bundles and the caller's profile revisions |
| `GET /v1/receipts/{evaluationId}` | `receipts:read` scope | The caller tenant's receipt record |
| `GET /v1/ready` | any valid token | Configuration and binding checks; never makes a billed call |
| `GET /v1/health` | public | `{"status":"ok"}` and nothing else |

Every authenticated route takes a bearer service JWT (EdDSA/Ed25519 or ES256) from an issuer in
`HM_TRUSTED_ISSUERS` (`[{"iss","jwks":{"keys":[...]},"audiences"?}]`), with `aud` = `HM_AUDIENCE`
(or the issuer's `audiences`), `exp`, optional `nbf`/`iat` (60 s skew), `jti`, `tenant` and `scope`.
A request's `source.tenantId` must equal the token's `tenant` (403 otherwise). Idempotency
records and receipts live in a per-tenant Durable Object for `HM_RETENTION_SECONDS` (default 24 h);
reusing a key with a different request is `409 idempotency_conflict`. Optional:
`HM_POLICY_OVERLAYS` (`{tenant: {profileId: PolicyOverlay}}`, tighten-only; a tenant with an
overlay can pin only the overlay's revision), the `AI` binding (Clef; without it, classification
is unavailable and the profile's failure mode applies), `HM_AI_GATEWAY_ID` and the
`TENANT_RATE_LIMITER` rate-limiting binding. Logs are JSON lines with fixed event names and
content-free fields only.

## Development

```sh
pnpm install
pnpm lint
pnpm test
```
