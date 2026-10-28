# T1 — trusted, opt-in, content-free moderation telemetry

**Status:** implemented on PR #13 as an *internal validate-and-discard transport*, disabled by default. This is **not** a historical metrics store, Flightdeck integration, student monitoring approval, or a legal/ZDR certificate.

Related: [Temporal implementation plan](../design/temporal-implementation-plan.md), [event data model](../design/temporal-events-and-api.md), [FERPA/COPPA](../privacy/ferpa-coppa.md), [ZDR](../privacy/zero-data-retention.md).

## Components

| Path | Role |
|---|---|
| `packages/telemetry-contracts` | Fixed-field v1 envelope, strictly validated source/grade/tenant allowlist, explicit required HMAC secrets |
| `packages/telemetry-sink` | Signed POST over a Cloudflare service binding, authentication verification, no automatic retry |
| `apps/worker/src/metrics.ts` | Emits after successful, **committed and not replayed** evaluations; no content included |
| `apps/telemetry-worker` | Internal-only authenticated receiver, **defaults to disabled**, accepts and discards validated envelopes |
| `packages/temporal-analytics` | Prior synthetic-only time aggregation, not connected to T1 receiver |

T1 deliberately does not persist raw events, not even to WAE; its only supported receiver mode is `validate_only` and the response explicitly states `persisted:false`. No D1, R2, Queue, Analytics Engine or other analytics storage bindings are present. Durable dedupe, event-time rollups, controlled TTL, completeness/coverage and dashboards remain T2/T3.

## Security / privacy controls

1. **No collection unless ALL gates are present:** producer `HM_TELEMETRY_ENABLED="true"`, strict per-tenant allowlist with 32+ character key, optional `METRICS_COLLECTOR` service binding, and receiver `HM_TELEMETRY_ACCEPT="validate_only"` with matching per-tenant grant. Missing/invalid config silently disables emission; invalid receiver config denies all.
2. **Tenant-scoped signing:** source signs the literal body plus tenant ID and Unix timestamp with HMAC-SHA256. The collector checks the signature using the configured key for that tenant, clock skew ±300 seconds, and its independently configured product/grade policy. The tenant is *never* taken from an unsigned JSON field.
3. **Strict schema:** exactly schemaVersion 1 and 1–16 events, ≤16 KiB, fixed operational enums, no extra keys. No student IDs, names, user IDs, message IDs, case IDs, free-form text, image bytes, source surface, cost center, provider error or arbitrary category labels can be serialized by the adapter. Even signed requests with unexpected fields are denied.
4. **No default HTTP publication:** collector `workers_dev:false` and no routes in its Wrangler config. Tenant-HMAC verification is defense in depth, not a reason to expose the endpoint publicly.
5. **No response or telemetry leakage:** outbound send is scheduled using `ExecutionContext.waitUntil` only after the source idempotency/receipt store successfully completes. Failed/unauthenticated evaluations and idempotent replays emit nothing. Unavailable collector logs a fixed event code, never request bodies or exception messages, and moderation response remains unchanged.
6. **Only trusted coarse dimensions:** product comes from the validated evaluation source and must match the configured tenant grant; grade is derived from a pinned profile (`student-6-8`, `student-9-12` or `educator`), not from a user-entered field. Unknown profile maps to `unspecified`, which requires explicit allowance. Calendar is always `unknown` until district-owned calendar lookup is implemented. Candidate flag category is `other`; no inferred severity or bullying claim is exported.
7. **No training or inference changes:** existing Clef, policy floors and content/receipt contracts remain intact.

**Important limitations:** HMAC alone does *not* make a request single-use: a captured signed event may be replayed within the five-minute window. T1 intentionally has no exact dedupe or durable collection; T2 adds a transactional source outbox and idempotent ingress. The per-event timestamp itself may correlate with a student in a tiny cohort; nothing is persisted in T1, but T2 must **aggregate before storing analytics** and apply suppression, access limits, disclosure safeguards and retention review. HMAC keys are secrets and must be rotated when compromised. Stateless “no storage” does not override Cloudflare account-level network logging/security records.

## Explicitly opted-in configuration (controlled pilot ONLY)

**A.** Create district-specific HMAC secrets (at least 32 random printable ASCII characters) **per tenant**, never shared between tenants. Keep them in the organization's secret store; don't commit them into repository files.

**B.** Deploy the collector separately using `apps/telemetry-worker/wrangler.jsonc`. It has no external route:

~~~sh
cd apps/telemetry-worker
pnpm exec wrangler deploy
# Only after independent district approval:
# wrangler secret put HM_TELEMETRY_ACCEPT  # value: validate_only
# wrangler secret put HM_TELEMETRY_TENANTS # JSON with permitted tenant grants
~~~

A synthetic example of the secret JSON **shape** (NOT a usable credential):

~~~json
{
  "tenant_educateos": {
    "source": "educateos",
    "gradeBands": ["g9_12"],
    "signingKey": "REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS"
  }
}
~~~

Actual tenant identifiers and permitted age bands require authorization. **Do not enable `g6_8`, `k5` or other data about under-13 children until the district's specific FERPA/COPPA and processor review is approved.** No student cohort is automatically authorized by a code sample.

**C.** In the source Hall Monitor Worker Wrangler config, intentionally add an internal service binding *only for the approved deployment*:

~~~json
"services": [
  { "binding": "METRICS_COLLECTOR", "service": "hall-monitor-telemetry" }
]
~~~

The default source `apps/worker/wrangler.jsonc` does **not** include this binding. Set source Worker secrets `HM_TELEMETRY_TENANTS` (same approved grants), `HM_TELEMETRY_ENABLED=true`. The existing `scripts/deploy-worker.mjs` uploads only secrets provided in the deploying environment, leaving previously set secrets unchanged; to turn telemetry **off**, rotate/remove the opt-in secret or explicitly set it to `false` and disable the binding. For a completely disabled deployment, omit the binding and do not set the secrets.

**D.** Run a synthetic test and verify the collector returns `202` with `{"code":"validated_not_persisted","accepted":N,"persisted":false}`. There is **no** historical query endpoint and the receiver keeps no event record. Never call successful validation “durable telemetry”.

**E.** Independently check Worker observability settings, account-level Logpush/exports, AI Gateway log controls and downstream cloud retention. The collector has application observability disabled but does not globally disable Cloudflare account logging. Consult [ZDR controls](../privacy/zero-data-retention.md). Do not use this T1 integration with real student data until necessary school review is complete.

## Test and validation

- `pnpm install --frozen-lockfile` (new workspace importer entries tracked).
- `pnpm lint` (root + Worker + telemetry Worker typechecking, existing boundary/OpenAPI checks).
- `pnpm test` (new contract/HMAC/receiver/Worker integration tests plus existing suite).
- `pnpm rollback-drill --out rollback-drill.json` (existing decision and policy rollback safety tests).
- Tests use synthetic messages and ephemeral HMAC keys. They verify no student content, synthetic token or source identifier crosses the metrics body boundary.
- No live collector/remote service deployment is executed by CI. Cloudflare production bindings and district access controls still need separate review.

## Intended T2 handoff

Before claiming a usable chart, implement an exact per-tenant/source event ledger, unique event ID carried **only in a separately protected transport envelope**, idempotency across retries and replays, validated district local time/calendar and event-time/ingestion-time distinction, late-event correction, receipt and operational coverage, aggregation with k/disclosure protection, explicit data TTL (WAE's published three-month retention may be unsuitable), and safe T3 read-only Flightdeck queries. Avoid storing per-message analytics rows or sensitive low-cohort event timestamps. Any T2 migration of the T1 collector must preserve the strict auth and deny-by-default posture.
