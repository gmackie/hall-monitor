# Hall Monitor

Product-neutral moderation and evaluation service shared by EducateOS (formerly SchoolOS) and PlayTrek.

Hall Monitor answers one question: *is this content or requested activity appropriate for this
product, role, curriculum context and institutional policy, and what should happen next?* It
returns findings and a decision (`allow`, `coach`, `hold`, `block`, `support`) plus a content-free
cost receipt. It never authorizes access to student data, impersonates a teacher, or awards grades.

## Safety intelligence research and opt-in telemetry

A detailed **design package and synthetic-only temporal analytics foundation** for privacy-preserving cyberbullying prevention, social-action moderation,
pseudonymous incident correlation, student nudges, provider-independent Nouls, FERPA/COPPA,
Zero Data Retention, and limited external-evidence workflows lives at
[docs/design/README.md](docs/design/README.md). See the [research/source register](docs/references.md)
and [validation milestones](docs/validation-and-rollout.md).

The existing Worker remains a request-scoped evaluator with optional, **disabled-by-default**
content-free telemetry via an authenticated internal service binding. T1 validates and discards
events. The separate v2 protocol adds a durable outbox and exact coarse rollups with trusted
time and explicit retention admission; its receiver is not production-verified or enrolled for
real sources. Runtime coverage remains unavailable and there is no reporting API/dashboard.
See the [T1 guide](docs/implementation/t1-trusted-telemetry.md) and
[durable telemetry guide](docs/implementation/t2-durable-telemetry.md).

There is **no shipped incident graph, identity vault,
cross-conversation monitoring, OSINT collector, teacher case viewer or student nudge UI**.
The proposed case evidence service would be separate from the current content-free receipts and
would require district-specific legal, safeguarding, security, provider and model calibration
approvals before any learner deployment. The separate `packages/temporal-analytics` module has
strict content-free validation, U.S. time-zone/DST aggregation, privacy display gates,
scenario planning and an offline priority/shift staffing queue simulator, all with synthetic tests; it does **not** instrument real student data. See the
[temporal system design](docs/design/temporal-analytics.md) and
[U.S. time-of-day/day-of-week research](docs/design/us-moderation-timing.md). Do not interpret the new documents as a launch approval.

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
| `packages/shadow-report` | Shadow-run reports and policy decision diffs over synthetic corpora (private) |
| `packages/temporal-analytics` | Strict synthetic/offline time-bucket, DST, aggregate, suppression, cost and staffing-queue reference implementation (not wired to live Worker) |
| `packages/telemetry-contracts` | Strict content-free v1/v2 batches, signing/ack domains and retention policies |
| `packages/telemetry-sink` | Internal signed v1 emitter and v2 delivery/ack validation |
| `packages/telemetry-coverage` | Isolated experimental evidence model; no runtime completeness/zero classification |
| `apps/telemetry-worker` | Internal v1 validate/discard and v2 durable aggregate receiver; default off, not production-verified |
| `apps/worker` | Cloudflare Worker HTTP API |

## Rules

The [pilot charter](docs/launch/pilot-charter.md), [custody decision](docs/privacy/record-custody-decision.md)
and [capability matrix](docs/market/capability-matrix.md) distinguish source implementation from
deployment, institutional approval and proposed features. The initial study remains synthetic.
Open-source distribution is intended, but no root license has been selected; existing packages
use a private authenticated registry. Do not treat repository visibility as a license or supported
school deployment agreement.

- No product code: shared packages never import `@playtrek/*`, `@schoolos/*` or `@gadgets/*`
  (`pnpm check:boundaries`).
- No raw content in receipts, logs or metrics. Money is integer nanodollars (10⁻⁹ USD), never floats.
- Fixtures are synthetic.

## Worker API

`apps/worker` serves the HTTP API (see [Deploying](#deploying)):

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/evaluations` | `evaluate` scope | Evaluate one request; idempotent by `idempotencyKey` |
| `POST /v1/evaluations:batch` | `evaluate` scope | Up to 50 `content.candidate` / `assessment.evaluator-result` requests |
| `GET /v1/capabilities` | any valid token | Supported versions, kinds, bundles and the caller's profile revisions |
| `GET /v1/receipts/{evaluationId}` | `receipts:read` scope | The caller tenant's receipt record |
| `GET /v1/ready` | any valid token | Configuration and binding checks; never makes a billed call |
| `GET /v1/health` | public | `{"status":"ok"}` and nothing else |
| `GET /v1/openapi.json` | public | The OpenAPI 3.1 document for this API |

The OpenAPI document is generated from the zod contracts (`z.toJSONSchema`) and committed at
[`apps/worker/openapi.json`](apps/worker/openapi.json). After changing a contract or a route, run
`pnpm openapi` and commit the result; `pnpm lint` (and so CI) fails on drift via `pnpm openapi:check`.

Every authenticated route takes a bearer service JWT (EdDSA/Ed25519 or ES256) from an issuer in
`HM_TRUSTED_ISSUERS` (`[{"iss","jwks":{"keys":[...]},"audiences"?}]`), with `aud` = `HM_AUDIENCE`
(or the issuer's `audiences`), `exp` (at most one hour ahead), optional `nbf`/`iat` (60 s skew), `jti`,
`tenant` and `scope`. Tokens are single-use: the `TokenReplayGuard` Durable Object records each
verified `(iss, jti)` until `exp` + skew (purged by alarm) and answers a replay with `401
unauthorized`, so callers mint a new token per request and per retry (the client's
`serviceTokenSource` does; transports ask for a token on every attempt). Without the
`TOKEN_REPLAY_GUARD` binding, authenticated routes fail closed with 503.
A request's `source.tenantId` must equal the token's `tenant` (403 otherwise). Idempotency
records and receipts live in a per-tenant Durable Object for `HM_RETENTION_SECONDS` (default 24 h);
reusing a key with a different request is `409 idempotency_conflict`. Optional:
`HM_POLICY_OVERLAYS` (`{tenant: {profileId: PolicyOverlay}}`, tighten-only; a tenant with an
overlay can pin only the overlay's revision), the `AI` binding (Clef; without it, classification
is unavailable and the profile's failure mode applies), `HM_AI_GATEWAY_ID` and the
`TENANT_RATE_LIMITER` rate-limiting binding. Logs are JSON lines with fixed event names and
content-free fields only.

**Shadow mode.** `HM_TENANT_MODES` (`{tenant: "shadow" | "enforce" | {"mode": "shadow",
"allowStudentShadow": true}}`) sets a tenant's enforcement mode; unlisted tenants, and every tenant
when the JSON is invalid, are enforced. The mode is configuration for the verified tenant, never a
request field. A shadow result returns `decision: "allow"` with reason code `hall_monitor.shadow`
and records the would-be decision and reason codes in the optional `shadow` field (an additive
1.0 field, so older clients simply enforce the `allow`); `evaluation.completed` logs carry `mode`
and `shadowDecision`. Two outcomes are never shadowed: `support`, which routes a person in distress
to help, and anything under a student-facing profile whose input moderation is `required`, unless
the tenant sets `allowStudentShadow` (logged as `shadow.refused`). Such profiles exist so that a
learner never sees unmoderated content; shadowing them would let blocked content reach a child
while the service appears to moderate, so the opt-in is reserved for synthetic or staff-only
traffic under the [launch checklist](docs/launch/launch-checklist.md).

## Deploying

Production is deployed by ForgeGraph (`.forgegraph.yaml`): a merge to `main` runs `wrangler
deploy` from a ForgeGraph node once CI is green, then copies the stage's secrets to the Worker.
Everything the Worker reads except `HM_AUDIENCE` (`HM_DIGEST_KEY`, `HM_TRUSTED_ISSUERS`,
`HM_POLICY_OVERLAYS`, `HM_TENANT_MODES`, `HM_AI_GATEWAY_ID`) is a Worker secret, because a deploy
replaces the Worker's `vars` with `wrangler.jsonc`'s and never touches secrets. `HM_DIGEST_KEY` is
required: without it every evaluation is refused. To deploy by hand instead, run
`node scripts/deploy-worker.mjs`, which uploads whichever of those settings are set in its
environment with the new version and keeps the rest.

## Image moderation

`content` may be `{"type": "image", "images": [{"mimeType", "base64"}], "text"?}`: one to four
embedded PNG, JPEG or WebP images (padded base64 whose file signature matches `mimeType`; at most
4 MiB each and 8 MiB in total, decoded; no URLs), with optional accompanying text. These are Clef's
own image limits. The accompanying text goes through the deterministic evaluators like any text.
The images go to the classifier, but only under a profile with `imageModeration`. When a profile
does not moderate images, the result carries `hall_monitor.image_moderation_disabled` and is
resolved as an unavailable classifier. A `fail_closed` profile therefore holds every image.

| Built-in profile | Images |
|---|---|
| `educator`, `published-content` | Classified |
| `student-6-8`, `student-9-12` | Held, until image thresholds are calibrated per band and a new floor revision enables them |

Overlays stay tighten-only. Under `fail_closed`, off is the strict setting, so an overlay can turn
images off but not on. Under `deterministic_only` it is the reverse. Images are sent to Clef-flash
and escalated to Clef with the same questions, reworded for images; both models accept the same
images. Clef-omni is not used: it adds audio and video, which this API does not accept, and costs
$0.15 per million input tokens against Clef-flash's $0.038. Image tokens are billed as input tokens
(one per 32x32 block plus 3, capped at 1,024 per image). Receipts use the provider-reported input
tokens, which include them. A call without reported usage is recorded with unknown cost; image
tokens are never estimated from bytes. Image bytes are never logged, stored or echoed: idempotency
keeps only a keyed digest of the request. `GET /v1/capabilities` lists `contentTypes`.



The [calibration harness](docs/implementation/calibration-harness.md) creates blinded synthetic
review packets and scores independently labelled held-out observations. It supplies no human
approval or live threshold activation.

`pnpm shadow-report` runs the real evaluation core over the frozen synthetic corpus (or
`--cases file.jsonl`, where every line must carry `"synthetic": true`) and reports the decision
distribution per profile, grade band and category, agreement with the expected decisions,
precision and recall per category and band (`scoreCorpus`), measured p50/p95 latency per stage,
and the estimated gross cost per 1,000 evaluations from the receipts.

```sh
pnpm shadow-report --profile student-9-12 --out report.json --markdown report.md
pnpm shadow-report diff --candidate candidate-overlays.json --out diff.json
pnpm shadow-report render report.json
```

`diff` evaluates the same corpus under a baseline (built-in profiles, or `--baseline`) and a
candidate policy revision (`{profileId: PolicyOverlay}`, applied tighten-only as the Worker does)
and lists every case whose decision changed, by transition and by reason code. The library also
diffs resolver versions (`resolverVariant`). `--classifier` is `fake` by default (a local
all-clear stand-in with estimated usage, so costs are labelled simulated), `none`, or `gateway`
(real, billed Clef calls via AI Gateway with payload logging off; synthetic cases only). Reports
hold identifiers, codes and numbers; `--include-text` adds the synthetic text of mismatched or
changed cases.

## Launch readiness

[`docs/launch/`](docs/launch/) holds the [launch checklist template](docs/launch/launch-checklist.md)
(the M7 gates, each with evidence and owner fields), the
[incident runbook](docs/launch/incident-runbook.md) and the
[rollback drill](docs/launch/rollback-drill.md). `pnpm rollback-drill` runs the drill against the
workerd test harness; it is also part of `pnpm test`.

## Consuming from another repo

Each `v<version>` tag publishes the packages to the private ForgeGraph package registry
(`https://npm.forgegraf.com/`) and attaches the same `pnpm pack` tarballs to a GitHub Release
(`.github/workflows/release.yml`). Nothing is published to public npm.

The registry owns the `@gmacko` scope (it does not proxy it from npm), so point the whole scope at it.
`@gmacko/lti` and `@gmacko/clever` are mirrored there byte-for-byte, so their lockfile integrity is
unchanged. In the consumer's `.npmrc`, with a token from `forge registry token create`:

```ini
@gmacko:registry=https://npm.forgegraf.com/
//npm.forgegraf.com/:_authToken=${FORGEGRAPH_REGISTRY_TOKEN}
```

Then depend on versions as usual, e.g. `"@gmacko/hall-monitor-client": "0.4.0"`.

Without registry access, download the release tarballs into the consuming repo (for example
`vendor/hall-monitor/`) and use `file:vendor/hall-monitor/<tarball>` both in the dependencies and in
`overrides` for every `@gmacko/hall-monitor-*` name, since packed manifests depend on each other by
version.

## Development

```sh
pnpm install
pnpm lint
pnpm test
```
