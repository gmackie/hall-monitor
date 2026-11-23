# HM-30: evaluation read API and route explainability (0.5.0)

Product UIs such as PlayTrek and EducateOS show the outcome of an evaluation: the decision,
findings and reason codes, which models ran and whether they escalated, and the cost. Before
0.5.0 a product could see that only in the response to its own `POST`. The only read endpoint was
`GET /v1/receipts/{id}`, which returns cost and nothing else, and full results were kept for
24 hours, keyed by idempotency key. HM-30 adds a retained, content-free evaluation record, list and
get routes for it, an explicit `route` on every result, located `evidence` on findings, and a
reason-code catalog. Every change is additive within wire schema `1.0`.

## Endpoints

| Route | Scope | Returns |
|---|---|---|
| `GET /v1/evaluations/{evaluationId}` | `evaluations:read` | `EvaluationRecord`. Returns `404 invalid_request` when the record is unknown, expired, or belongs to another tenant. |
| `GET /v1/evaluations?…` | `evaluations:read` | `EvaluationPage`, newest first. |
| `GET /v1/reason-codes` | any valid token | `ReasonCodeCatalog` |

The auth scheme is the same as every other route: a single-use service JWT from a trusted issuer.
The records are always the token's tenant's. Each tenant has its own Durable Object, so another
tenant's id is never found, not forbidden. Mint a new token for every page.

### List parameters

All parameters are optional and combine with AND. Unknown, repeated or invalid parameters return
`400 invalid_request`. The message names the parameter, never its value.

| Parameter | Meaning |
|---|---|
| `limit` | 1–200; default 50 |
| `cursor` | `nextCursor` from the previous page |
| `from`, `to` | ISO timestamps on `recordedAt`; `from` inclusive, `to` exclusive |
| `decision` | The enforced decision. Shadow-mode records enforce `allow`; their would-be decision is in `result.shadow`. |
| `evaluationKind`, `profileId`, `surface`, `requestId` | Exact match |
| `reasonCode` | Matches a top-level, finding or shadow reason code |
| `modelId` | Any model called on the route or billed on the receipt |
| `mode` | `enforce` or `shadow`, the tenant's enforcement mode |
| `escalated` | `true` or `false`: whether any model family escalated |

Order is `recordedAt` descending, then `evaluationId` descending. Cursors are opaque.

## Shapes

```ts
EvaluationRecord = {
  schemaVersion: "1.0"
  evaluationId, requestId, tenantId
  product, surface, evaluationKind
  contentType: "text" | "digest" | "image"
  policy: { profileId, revision }
  context: { audience, gradeBand?, subject?, activityKind?, graded?, costCenterId, parentRequestId? }
  mode: "enforce" | "shadow"
  result: EvaluationResult        // exactly what POST returned, including receipt and route
  recordedAt, expiresAt
}
EvaluationPage = { schemaVersion: "1.0", items: EvaluationRecord[], nextCursor: string | null }

EvaluationResult.route? = { classifiers: ClassifierRoute[] }
ClassifierRoute = {
  family                          // "clef" today; "clairic" later
  evaluatorId, evaluatorVersion
  status: "ran" | "skipped"
  skipReason?: "moderation_off" | "deterministic_decisive" | "digest_content"
             | "image_moderation_disabled" | "budget_exhausted" | "kind_not_routed"
             | "profile_disabled" | "not_authorized" | "content_not_supported"
  mode: "enforce" | "shadow"      // the family's mode: shadow findings never reach the decision
  calibrationRevision: string | null
  calls: { modelId, role: "primary" | "escalation",
           outcome: "scored" | "malformed" | "failed" | "timed_out" | "denied",
           attemptId? }[]         // attemptId links to receipt.attempts[]
  escalated: boolean
  escalationReason?: "ambiguous_band" | "low_confidence"
  fellBack?: boolean
  shadowFindings?: Finding[]
}
Finding.evidence? = { field, span?, confidence? }[]

ReasonCodeCatalog = { schemaVersion: "1.0", revision, codes: { code, category?, title, description }[] }
Capabilities.models? = { family, modelId, role, status: "ga" | "preview" }[]
Capabilities.reasonCodesRevision?
```

To show a model path, read `route.classifiers[].calls`. For example, `clef-flash (scored) → clef
(scored), escalated: ambiguous_band`. Join `attemptId` to `result.receipt.attempts[]` for
per-call tokens and cost. `receipt.totalGrossUsdNano` is the total cost in integer nanodollars, as
a string. When `hasUnknownCost` is true, the total is a lower bound.

## Storage and retention

Records live in a new `evaluations` table in the tenant's existing `IdempotencyStore` Durable
Object. They are written in the same transaction as the idempotency result and the receipt, so a
committed evaluation always has a record and a failed or abandoned one never does. Replaying an
idempotent request returns the stored result and writes no second record.

Records are kept for `HM_EVALUATION_RETENTION_SECONDS`: 30 days by default, at most 400 days. An
invalid value falls back to the default. This is separate from `HM_RETENTION_SECONDS` (24 hours),
which still governs idempotency and receipts. The Durable Object's alarm purges expired records.
Indexed columns hold only identifiers, labels, codes and model ids.

## Content-free by construction

A record holds the request's identifiers and labels and the result. It never holds the text,
images, answer key or digest. Findings and evidence carry spans (UTF-16 offsets) and machine
codes, never matched text. A product that still holds the original content can highlight the
spans. Nothing else can recover the content.

## Client 0.5.0

```ts
client.evaluation(evaluationId)              // EvaluationRecord | null
client.listEvaluations({ decision: "hold", limit: 50 })
for await (const record of client.iterateEvaluations({ surface: "student.chat" })) { … }
client.reasonCodes()
client.evaluateGoverned(request)             // POST /v1/evaluations:governed
```

Mint read tokens with the `evaluations:read` scope, for example
`serviceTokenSource({ …, scope: ["evaluate", "evaluations:read", "receipts:read"] })`.

## Upgrading from 0.2.0 or 0.3.0

| Since | Change | Breaking for |
|---|---|---|
| 0.3.0 | `Product` gains `educateos` | Exhaustive `switch` or `Record<Product, …>` code must add the new member |
| 0.4.0 | `Product` drops `schoolos` | Callers that still send `schoolos`. The request is rejected. |
| 0.5.0 | `HallMonitorClient` gains `evaluateGoverned`, `evaluation`, `listEvaluations`, `iterateEvaluations`, `reasonCodes` | Hand-written classes or fakes that `implements HallMonitorClient` |
| 0.5.0 | New read routes need the `evaluations:read` scope | Token issuers that mint only `evaluate` |
| 0.5.0 | Optional `route`, `Finding.evidence`, `Capabilities.models`, `Capabilities.reasonCodesRevision` | Nothing. zod strips unknown keys, so 0.2.0 clients parse 0.5.0 responses. `packages/contracts/__tests__/legacy.test.ts` pins this. |

No response enum (`Decision`, `FindingCategory`, `Severity`, `DegradedReason`, `ErrorCode`) gained
a value. Later model families (Clairic) reuse existing finding categories, so older clients keep
parsing.
