# Flightdeck integration — safety operations dashboard UX and query plan

**Design only; not a shipped Flightdeck dashboard or a student-monitoring UI.** Flightdeck is an optional district-side analytics surface; it receives aggregated operation metrics, not student chat content or protected incident graph evidence. School staff access through Gatekeeper/Nathan, with role- and purpose-scoped datasets.

## UX navigation and scope

Navigation: **Overview / 168-Hour Demand / Safety Funnel / Human Operations / Intervention Outcomes / Model & Cost / Privacy Health / Comparisons**. District admin sees district-wide approved metrics; teacher sees only sufficiently aggregated, educationally useful class climate summaries. A safeguarding investigator opens *separate protected case service*, not an analytics chart drilldown.

Filters fixed by server policy: permitted school(s)/cohort, school-local time zone, school calendar kind, dates, known model/policy release, category family, source product and modality. No personal IDs, raw queries, “all messages about student X”, multi-hop relationship search, external social handles, student name search, tiny groups or unapproved cross-district filters.

### Dashboard 1: executive overview

~~~text
HALL MONITOR / SAFETY OPERATIONS                                      Last 28 days
[ School-local zone: America/Detroit ]  [ Calendar: Instructional ]  [ Approved cohorts ]

Eligible checks        AI routed           Candidate flags/1K       Human reviews
  1.2M                 13.8%                10.4                   1,345
  coverage 99.1%       p95 710ms            policy rev 17          routine/priority

Priority queue today                 Coverage health
  urgent awaiting ack  [restricted]  [OK] intake  [OK] inference
  routine awaiting review 89         [WARN] qualified after-hours staffing*
  oldest routine case  22h            * Never imply 24/7 from an online Worker

Trends [volume] [rates] [latency]  | data quality / policy change markers
~~~

Numbers above are **UI fiction**. Do not build a dashboard that fabricates current U.S. rates, or uses a sensitive low count as a public badge. Any urgency widget visible to ordinary teachers must hide small counts or use a non-inferential “contact safeguarding lead” status.

### Dashboard 2: hour-of-week view

168 local cells: weekdays Monday–Sunday, 24 hours, options for **evaluated volume**, **per-1,000 candidate flag rate**, **reports received**, **review queue arrivals**, **human review completions**, **time-to-protection**, and **recorded coverage**. Switching metrics changes both title and denominator legend.

Each cell displays one of: “measured”, “estimated/sampled”, “suppressed”, “insufficient exposure”, or “source unavailable”. Tooltips disclose local hour, zone, UTC offsets when DST relevant, numerator, denominator, reporting coverage, policy revision caveats and data freshness. **No student/source excerpt tooltip**.

A separate daily line chart uses exact UTC instants/offset to depict the skipped and repeated DST hour. The 168 visual tiles are *not* a literal 168-hour elapsed interval for those weeks.

### Dashboard 3: funnel

~~~text
Eligible submissions 1,000,000
   | 100% admitted / coverage status
   +-> deterministic resolution
   +-> Clef-flash routed (15%)
   |      +-> escalation (e.g., Clef)
   |      +-> unavailable/fail-closed
   +-> candidate flags / interventions
   +-> separate human reports (cannot be deduced from messages)
   +-> incident candidates
   +-> review jobs (queued, acknowledged, completed)
   +-> verified case outcomes / appealed / corrected / unresolved
~~~

**Never** present the report/case/review counts as a single strict conversion funnel: reports may be initiated independently and one incident may have multiple tasks. Show distinct links with explanatory units. Drilldowns only to aggregate subgroups that satisfy privacy bounds.

### Dashboard 4: human operations

Local-time heatmap of **new queue arrivals**, not content flags; urgency-stratified queues; qualified on-call coverage and acknowledgments; backlog age; staff capacity, completion time distributions and response SLA. Urgent queue metrics sourced from an exact protected ledger with an approved non-identifying projection—not sampled WAE. Show coverage gaps and “not staffed” plainly.

Alerts for: overdue urgent acknowledgment, after-hours coverage absent, backlog growth, sustained ingestion failure, policy changes causing sharp false-positive drift, confidential disclosures beyond role, or unauthorized model data route. Alerts should not include student identity or sensitive case details in ordinary notification channels.

### Dashboard 5: prevention, intervention, fairness

Count nudges/edits/continues, but distinguish **engagement** from **outcomes**. Plot independently substantiated harm, subsequent protective reports, appeal reversals, access restoration, aggregate participation effects and confidence intervals for evaluated experiments. Never interpret declining reports as automatically improved safety.

### Dashboard 6: model and cost

Hall Monitor's existing content-free nanoUSD receipts are source of truth for model cost. Pair routing rate, model/policy revisions, p50/p95 latency, timeouts/retries, unsupported image modalities, false-positive benchmarks, provider retention approval and total human-review workload. WAE sampled sums are approximate, not financial reconciliation or incident evidence.

### Dashboard 7: privacy and governance

Versioned policy approvals, provider route status, ZDR/config last verified, Gateway payload log settings, Logpush and cache checks, denied unauthorized transfers, unexpected log-sentinel findings, retention/retraction jobs, FERPA record request SLAs, restricted case access audit **counts**, and small-cohort suppression. Never leak evidence through audit labels or a chart export.

## API response example (conceptual)

~~~json
{
  "metric": "candidate_flag_rate_per_1000",
  "tenantScope": "district",
  "timeZone": "America/Detroit",
  "calendarRevision": "approved-2026-fall",
  "window": { "fromUtc": "2026-10-01T00:00:00Z", "toUtc": "2026-10-28T00:00:00Z" },
  "policyRevision": "builtin-1",
  "dataQuality": { "coverageFraction": 0.99, "sampled": true, "lateDataPresent": false },
  "cells": [
    { "weekday": 2, "hour": 10, "value": 12.4, "numeratorEstimated": 124, "denominatorEstimated": 10000, "status": "estimated" },
    { "weekday": 2, "hour": 11, "value": null, "status": "suppressed" }
  ]
}
~~~

**Illustrative only.** The real endpoint should not reveal a raw tenant identity in its body unless permitted, nor promise value accuracy from WAE alone. Pre-agreed filters and a server-held query template prevent SQL injection and sensitive drilling.

## Example Workers Analytics Engine SQL

For an **authorized district internal trend**, index and fixed dimension mapping from [LLD](temporal-analytics.md):

~~~sql
SELECT
  blob6 AS weekday_iso,
  blob7 AS hour_local,
  blob3 AS stage,
  SUM(_sample_interval * double1) AS estimated_events
FROM HM_SAFETY_TRENDS
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND blob3 IN ('content_evaluated', 'candidate_flagged')
GROUP BY weekday_iso, hour_local, stage
ORDER BY weekday_iso, hour_local, stage;
~~~

This uses **write/ingestion timestamp** for the query window. The row's derived local hour corresponds to occurrence time, but a late-arriving event may be counted within a later arrival window. For defensible historical event-time windows, use exact district-owned hourly rollups with explicit event-time date and correction revisions, not a WAE-only source. Source: [Cloudflare Analytics Engine SQL](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) and [sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/).

WAE currently retains data **for three months** per its [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/). A district requiring shorter operational retention must avoid writing identifiable or sensitive dimensions there and consider a shorter-TTL district-owned alternative. WAE itself is not an exact forensic event log. No PII, case identifiers, conversation IDs, URLs or arbitrary student data belong in columns or the index.

## Permissions and export

- Tenant-scoped service binding for data queries; no browser direct access to Cloudflare account analytics credentials.
- Read-only aggregate roles for admins; constrained small-cohort climate insights for teachers; separate case role for safeguarding.
- Minimum population/exposure and nonzero-outcome suppression **plus** complementary suppression, overlapping-query protection, cohort safeguards and audit.
- CSV/API exports follow the exact same redaction and authorization as screen tiles.
- Cross-district benchmark needs a separate opt-in, approved purpose, aggregating authority, version normalization and privacy protection; **not enabled by a basic local dashboard**.
- No student-facing model-reported “behavioral score” dashboards.

## Acceptance tests

Test zero vs missing coverage; DST skipped/repeated hour; attempted small-cohort differencing; cross-tenant access; repeated queries across rolling windows; misleading case-count funnel; incorrect denominator; urgent exact ledger vs WAE disagreement; version switch changing apparent flag rate; log payload injection; role spoofing and unapproved data export.
