# Temporal Moderation Metrics — definitions, denominators and data quality

**Version:** draft metrics catalog v0.1. Intended for Flightdeck/district operations; not an individualized risk model, not proof that a human service is staffed 24/7. See [the system LLD](temporal-analytics.md).

## Required event families and timestamps

| Symbol | Stage count | Timestamp | Source of truth |
|---|---|---|---|
| E | Eligible content submissions evaluated | `classifiedAt` / `evaluationCompletedAt` | Hall Monitor |
| F | Submissions with at least one qualifying safety flag | `flaggedAt` | One deduplicated flag per evaluation |
| R | Accepted human reports | `reportedAt` | Source report intake |
| I | New incident candidate opened | `incidentOpenedAt` | Incident service |
| Q | Jobs entering a qualified review queue | `queuedAt` | Review service |
| V | Completed human review tasks | `reviewedAt` | Review service |
| P | Protective actions actually executed | `actedAt` | Source product / safeguarding |
| C | Incident resolutions | `resolvedAt` | Case service |

**Never** reinterpret a report as the occurrence time of underlying harm. One incident can have many reports; one report can concern multiple events; a review can re-open an incident. Use different units for messages, reports, reviews, incidents and unique students. Avoid a generic “moderation count.”

## Dashboard metric catalog

| Metric | Definition | Necessary denominator / caveat |
|---|---|---|
| Eligible volume | Count E by event time | Instrumentation coverage and tenant/source window |
| Model route share | AI-routed eligible requests / eligible requests | Only matching permitted source, feature and observation window |
| Candidate flag rate | 1,000 × F / E | Exactly one F per evaluated submission; changes when policy/model changes |
| Report volume | Count R | Reports are help requests, not proven harmful incidents |
| Report confirmation rate | Human-reviewed reports supporting an observed safety concern / human-reviewed reports | Requires explicit human adjudication; unknown/unreviewed not false |
| Review load | Count Q, V separately | Review jobs, not distinct incidents |
| Queue backlog | Accepted jobs - completed/cancelled jobs as-of instant | Exact operational ledger; never estimate from WAE sampling |
| Time to first human acknowledgment | `acknowledgedAt - queuedAt` | Completed jobs only; censor pending jobs separately |
| Time to protection | `actedAt - firstActionableSignalAt` | Requires documented “actionable” designation; track pending/censored cases |
| Response SLA attainment | Qualified actions within approved target / all eligible actions with matured windows | Exact priority-specific numerator and denominator |
| False-positive rate | False positives / truly negative reviewed test cases | Requires benchmark adjudication; operational flagged “nonactionable” ≠ statistical FPR |
| Precision (PPV) | Confirmed true positives / all reviewed flagged positives | Review selection bias; not population PPV unless sample representative |
| Recall | True positives / all true positives in adjudicated corpus | Needs labeled negative sample, not only flagged cases |
| Appeal/retraction rate | Reversed outcomes / appeal-eligible reviewed outcomes | Appeals depend on awareness/access |
| Inference cost | Provider-reported usage and nanoUSD receipts | Not equivalent to human or system operations cost |
| Unserved urgent workload | Urgent signals lacking qualified acknowledgment in target window | Exact safeguarding ledger; do not use sampled WAE |
| Nudge effect | Subsequent verified harm/support and intervention differences | Compare against appropriate controls, chilling effects, confounding |
| Privacy leakage | Authorized disclosure count + observed unexpected payload leakage | “Zero observed” is not proof of provider-internal non-retention |

### Important measurement rules

1. **Population/exposure:** a spike in F when E doubles can leave F/E unchanged. Per-student rates may be privacy-invasive; use content exposure and school calendar instead.
2. **Temporal time series:** use occurrence time for behavior, reporting time for help-seeking, completion time for staffing. Separate “when happened” from “when discovered.”
3. **Censoring:** unresolved cases should remain in the risk set; reporting an average delay only for completed cases biases estimates downward.
4. **Quality:** maintain producer health/coverage, late events, unknown categories, schema rejection, deduplication errors, clock skew and policy drift metrics.
5. **Daylight saving:** an actual local week can have 167/169 clock-hours. Heatmap 168 cells do not imply equal exposure. Model hourly *rate with matching exposure*.
6. **School calendar:** holidays, exams, teacher workdays, class schedules, seasonal breaks and remote-learning periods are categorical factors, not inferred student behaviors.
7. **Model policy drift:** category meanings/thresholds and supported image modalities are versioned. Do not compare flag counts across versions without calibration.
8. **Statistical uncertainty:** display confidence intervals and sample size for rates and benchmarks; flag underpowered comparisons. Do not present exact probabilities from small cells.
9. **Fairness:** stratified review by authorized grade bands, languages and assistive communication, with minimum cohort sizes and qualified review. No named-student analysis.
10. **Non-Independence:** forwarded messages, copied screenshots and coordinated reports do not provide independent case evidence, even if they are separate analytics events.
11. **Sampling:** WAE's `_sample_interval` is a weight, not a user event ID. Reweight aggregate counts, not exact case counts or duty-of-care outcomes.
12. **Corrections:** track revised adjudications and new outcomes rather than rewriting historical facts silently. Publish revision-aware time series.

## Safe examples: metrics with matching denominators

### Flag rate (eligible submissions as denominator)

Given 100,000 eligible submissions, 1,000 flagged submissions, and verified data coverage across the same selected days: 10 flags per 1,000 submissions. If only 20,000 submissions occurred in the late evening and 600 were flagged, evening is 30 per 1,000 submissions. Neither number proves harassment prevalence without category accuracy, calibration and source selection.

### Reporting clock versus harm clock

A school chat message is created Friday 21:30, student report arrives Saturday 09:00, review opens Monday 08:15 and protection is executed Monday 09:00. These belong to separate heatmaps. Reporting latency from Friday to Saturday is not review queue latency.

### Missing versus zero

A district failed to emit metrics from 02:00–03:00. The heatmap cell must show “coverage missing”, not “0 unsafe messages”. A no-student-activity period verified by a heartbeat and exposure inventory can legitimately be zero.

## Forecasting, not student risk profiling

Proposed aggregate model, trained only on sufficiently governed, calibrated district cohorts:

~~~text
N[day,hour,category] ~ NegativeBinomial(mean=μ, dispersion=φ)
log(μ) = log(exposure) + hour-of-week effect
         + school-calendar effect + category/release effects
~~~

The offset `log(exposure)` distinguishes volume from risk *rate*. Estimate uncertainty and out-of-sample forecast error. Negative-binomial is a modeling hypothesis and must be compared against simple historical medians, Poisson and other baselines. Do not apply a late-night multiplier to an individual student's message or change safeguarding thresholds based solely on hour.

## Flightdeck privacy levels

- **Local operator (district)**: approved cohort aggregates; no student-level telemetry; suppress sparse cells and small cohorts.
- **Safeguarding lead**: protected incident service with separate Gatekeeper case authorization; not a raw Flightdeck analytics drilldown.
- **Regional/national benchmark**: explicitly opted-in institutional aggregates with minimum cohort counts, protection against differencing and disclosure, privacy budget if using differential privacy; **not currently implemented**.
- **Public metrics**: only high-level reviewed aggregate findings with explicit population/sample/period provenance.

The prototype `aggregateHourOfWeek` and `flagRatePerThousand` work over synthetic fixed-field events. A production implementation must add coverage information, corrected dedupe, strict source authentication and cohort-level privacy controls. See [event architecture](temporal-events-and-api.md).
