# Hall Monitor incident runbook

Fill in the contacts before launch (launch checklist R8). Every step that changes production
(deploy, rollback, configuration) needs the owner's approval; agents may gather evidence but do
not deploy. Never paste request content into tickets or chat: use evaluation ids, receipt ids,
reason codes and log event names. Logs and receipts are content-free by design; keep it that way.

| Role | Name | Contact |
|---|---|---|
| Incident commander | | |
| Safeguarding lead (student incidents) | | |
| Hall Monitor on-call engineer | | |
| Finance / billing | | |
| Product contacts (SchoolOS, PlayTrek) | | |

Useful signals: Worker logs are JSON lines with fixed event names (`evaluation.completed`,
`evaluation.failed`, `shadow.refused`, `config.invalid`, `ratelimit.unavailable`,
`internal.error`); `GET /v1/ready` checks configuration and bindings without a billed call;
`GET /v1/receipts/{evaluationId}` returns a tenant's receipt record.

## 1. Moderation false negative (harmful content was allowed)

Severity: high when a learner was exposed; critical for self-harm or sexual content involving a
minor.

1. **Safeguard first.** If a learner may be at risk, the safeguarding lead follows the
   institution's procedure now. Hall Monitor work does not delay that.
2. Collect identifiers only: tenant, evaluation id, request id, decision, reason codes, policy
   revision, resolver version, evaluator bundle revision (all on the result and in
   `evaluation.completed`).
3. Check whether the tenant was in shadow mode (`mode: "shadow"` in the log, `shadow` on the
   result). If it was, and learners were exposed, set the tenant to `enforce` in
   `HM_TENANT_MODES` immediately: shadow mode must never cover learner traffic.
4. Reproduce with a **synthetic** case that has the same shape (never the real text): add it to a
   JSONL file with `"synthetic": true` and run `pnpm shadow-report --cases file.jsonl`.
5. Contain: tighten the tenant's overlay (`HM_POLICY_OVERLAYS`, tighten-only, new revision) or add
   an `actionOverrides` entry for the reason code; run `pnpm shadow-report diff --candidate ...`
   to see every decision the change moves before applying it.
6. Fix: add the synthetic case to the frozen corpus with its expected decision, fix the evaluator
   or threshold, bump the evaluator bundle or resolver version, and ship through review.
7. Record the timeline, identifiers, the diff report and the follow-up issue.

## 2. Cost spike

1. Confirm from receipts, not invoices alone: sum `totalGrossUsdNano` by tenant and purpose, and
   count attempts per evaluation and escalations (`modelId` of the escalation model).
2. Common causes: escalation rate above the profile's `escalation.maxShare` target, retries
   (many attempts per logical request), a product resubmitting without idempotency keys (no
   `idempotent-replayed` header on repeats), or a traffic surge from one tenant.
3. Contain: lower the tenant's rate limit (`TENANT_RATE_LIMITER`), fix the client's idempotency
   keys, or have the product pause the surface. Do not switch moderation off: required
   moderation is a floor, and an exhausted safety budget already blocks generative work while
   keeping support paths available.
4. Compare against the expected cost per 1,000 evaluations from the signed checklist (E1, E2).
5. Reconcile with the provider's usage export once available; record drift (E3).

## 3. Ledger outage (receipts cannot be stored or read)

Receipts and idempotency records live in each tenant's `IdempotencyStore` Durable Object.

1. Symptoms: `evaluation.failed` with `errorCode: "unavailable"`, `internal.error`, receipt reads
   failing, `/v1/ready` reporting `idempotencyStore: false`.
2. Evaluations fail closed (`503 unavailable`, retryable) rather than running unmetered. Products
   must treat that as Hall Monitor unavailable (section 4).
3. Do not clear storage. Records expire on their own after `HM_RETENTION_SECONDS`; a restart
   keeps them (rollback drill step 3).
4. After recovery, products retry with the **same** idempotency keys: completed evaluations replay
   without being billed again, and abandoned ones re-run.
5. Reconcile: compare the provider's usage for the window with stored receipts; attempts the
   provider billed but Hall Monitor never recorded are recorded as unknown cost in the incident.

## 4. Hall Monitor unavailable

1. Symptoms: products see timeouts, 5xx or `503 unavailable`; `/v1/health` fails or `/v1/ready`
   returns 503 with a failing check.
2. Product behaviour (verify per product, checklist R4): student-facing surfaces fail closed (hold
   or a friendly "try again later"); educator-only planning may continue under its own policy;
   support and safety resources stay reachable without Hall Monitor.
3. If the classifier alone is down (Workers AI 429 / 5xx), Hall Monitor is still up: student
   profiles hold (`hall_monitor.unavailable`, degraded `classifier_unavailable`), educator
   profiles decide from deterministic checks (`hall_monitor.deterministic_only`). That is the
   designed behaviour, not an incident in Hall Monitor itself; watch receipts for unknown cost.
4. If a deploy caused it, roll back the Worker to the previous version (`wrangler rollback`, owner
   approval) and confirm with `/v1/ready` and a synthetic evaluation. If a configuration change
   caused it (`config.invalid` in the logs), restore the previous variable value: invalid
   overlays fail closed, invalid tenant modes enforce everyone.
5. Afterwards, run `pnpm rollback-drill` at the restored commit and attach the record.
