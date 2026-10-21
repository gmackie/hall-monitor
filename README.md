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

## Consuming from another repo

The packages are not on npm (publishing needs owner approval). Each `v<version>` tag instead
attaches `pnpm pack` tarballs and a `manifest.json` to a GitHub Release
(`.github/workflows/release.yml`; `node scripts/pack-release.mjs` builds the same files into
`dist/release/` locally). Packed manifests depend on each other by plain version
(`"@gmacko/hall-monitor-contracts": "0.1.0"`), which would resolve against the npm registry, so a
consumer must override **every** `@gmacko/hall-monitor-*` name, including transitive ones, to the
release URLs. With pnpm 10+ put the overrides in `pnpm-workspace.yaml`:

```yaml
overrides:
  '@gmacko/hall-monitor-contracts': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-contracts-0.1.0.tgz
  '@gmacko/hall-monitor-costing': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-costing-0.1.0.tgz
  '@gmacko/hall-monitor-policy': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-policy-0.1.0.tgz
  '@gmacko/hall-monitor-evaluators': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-evaluators-0.1.0.tgz
  '@gmacko/hall-monitor-clef': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-clef-0.1.0.tgz
  '@gmacko/hall-monitor-core': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-core-0.1.0.tgz
  '@gmacko/hall-monitor-client': https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-client-0.1.0.tgz
```

(older pnpm: the same map under `"pnpm": { "overrides": { ... } }` in `package.json`), and depend on
the packages you use by the same URL. pnpm 11 and later refuse URL-resolved *transitive*
dependencies by default (`blockExoticSubdeps`), so URL overrides also need
`blockExoticSubdeps: false` in `pnpm-workspace.yaml`. To keep that protection on, download the
release tarballs into the consuming repo (for example `vendor/hall-monitor/`) and use
`file:vendor/hall-monitor/<tarball>` in both the overrides and the dependencies instead; local
tarballs are accepted with the default settings.

```json
"dependencies": {
  "@gmacko/hall-monitor-client": "https://github.com/gmackie/hall-monitor/releases/download/v0.1.0/gmacko-hall-monitor-client-0.1.0.tgz"
}
```

The packages ship TypeScript source (`exports` points at `./src/index.ts`, with `.ts` import
specifiers). Bundlers (Wrangler, Vite, esbuild) and `tsx` consume them directly; Node's built-in
type stripping does not run inside `node_modules`. Type-check consumers with
`moduleResolution: "Bundler"` and `allowImportingTsExtensions`.

**License: TODO (owner).** No package declares a license yet; the owner must choose one before
these tarballs are relied on outside this account.

## Development

```sh
pnpm install
pnpm lint
pnpm test
```
