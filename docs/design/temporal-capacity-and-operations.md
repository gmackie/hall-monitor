# Temporal moderation operations — queues, staffing, costs and time-aware forecasting

**Design, not a live response service.** Hall Monitor's current Worker can run whenever Cloudflare is available. That does **not** establish that the school or a contractor has qualified humans available overnight.

## 1. Different work queues, different risk

| Queue | Examples | Route | Service principle |
|---|---|---|---|
| S0: immediate safeguarding | Credible imminent violence, urgent self-harm disclosure, child-protection concern | Trained adult response and applicable emergency process | No score accumulation and no reliance on standard asynchronous queue alone |
| S1: priority welfare | Repeated substantial targeting, threats needing qualified evaluation, persistent denied access | Prompt designated safeguarding review and protective action as justified | Time-bound on-call escalation, documented ownership |
| S2: routine relational harm | Possible gossip propagation, exclusion, moderation manipulation | Private non-punitive friction/nudges; bounded human review during approved operating hours | Do not turn ordinary conflict into a discipline case |
| S3: automated procedural | Duplicate spam, flooding, unauthorized group mute, known malicious links | Local deterministic enforcement; appeals and accessibility exceptions | No human requirement for trivial rate limiting |
| S4: no action | Ordinary criticism, personal mute/ignore, consensual disagreement | No retention of speculative social sentiment | Protect student boundaries |

Emergency classifiers are not diagnosis or adjudication. Child safety and mandated reporting must follow qualified institutional policies; risk assessment and support decisions belong to accountable humans.

## 2. The three workload curves

Plan separate demand curves: (a) eligible submissions and automatic inference, (b) newly created human review tasks and incoming student reports, (c) tasks actually completed and protected actions. Use the right event-time for each. Human completion activity at 8 AM Monday may be *backlog from Friday*, not Monday behavior.

Contrast:
- Vendor-monitored school accounts show weekday/school-day incident concentration but after-hours cases.
- Anonymous youth reporting shows school-day interpersonal reports, evening mental-health/school-attack reports and a *higher fraction* of urgent tips after midnight.
- Global Reddit removals show automated rule-enforcement scale, not a comparable U.S. school-day incident curve.

These sources are **operational workload hypotheses**, not priors for judging individual students. See [US evidence](us-moderation-timing.md).

## 3. Staffing and queue dimensions

Required variables per approved district:
- time zone and operating calendar; pupil count only for high-level planning, not individually identifying events;
- eligible messages/hour and category-specific candidate flags/hour;
- share routed to Clef or another approved provider; retries, timeout and escalation rate;
- review-queue arrival rate by urgency **and by local clock**;
- first-review service time distribution (p50/p90/p99) for each priority class;
- reviewer qualifications, local shift roster, simultaneous concurrency, breaks, vacation, escalation contact trees;
- time from qualified acknowledgment to actual protective action (separately from review);
- proportion of abandoned/no-response cases and right-censored pending tasks;
- escalations to external emergency support, with restricted exact ledger.

**A normal-workday staffer is not an after-hours safeguard.** If a district promises 24/7 response, it must have tested qualified coverage, fallback, handoff and missed-ack alerts, not just webhooks or a PagerDuty-like endpoint.

## 4. Queueing reference model

For a rough check, Little's Law `L = λ W` describes average jobs in system given long-run arrival rate `λ` and time `W`, subject to steady-state assumptions. It is not a worst-case SLA or staffing schedule.

A multi-server M/M/c/Erlang-C calculation can estimate waiting for a homogeneous stationary Poisson arrival process and exponential review times. It is often too optimistic for synchronized school releases, coordinated pile-ons, exams, report bursts and severe escalations. A realistic production planner should also simulate:

- Non-stationary hourly arrivals with overdispersion (e.g. negative binomial, fit and validate).
- Separate urgent/routine priority queues; urgent tasks should have dedicated on-call capacity.
- Multiple task service time distributions and skill requirements.
- Shift changes, coverage gaps, DST, holidays and false-positive surges after model/policy changes.
- Workflow handoff times, retry/dedupe and review appeals.
- Queue admission/review coverage during off-hours; a restricted backlog of nonurgent tasks must not hide urgent ones.

Queue simulator acceptance tests: synthetic overload, mass reports, Friday night → Monday morning backlog, spring/fall DST, model release doubling flags, a reviewer unexpectedly unavailable, and a genuine emergency independent of queue. Output p50/p95 waits, worst-case censored backlog, utilization, SLA breach fraction, and confidence intervals.

## 5. Calendar-aware aggregate forecast

Recommended baseline: empirical day-of-week/hour median + school calendar. Compare with Poisson and negative-binomial regression *on aggregate task arrivals*:

~~~text
N[c,d,h] ~ NegBin(mu[c,d,h], dispersion[c])
log mu[c,d,h] = log(exposure[d,h])
  + baseline[c] + weekday_hour[c,d,h]
  + calendar_type_effect + policy_revision_effect
~~~

`exposure` must reflect supported chat volume, active instrumentation, school hours and holidays. Predict workload only. Do not change student-level bullying probability based on a late-night hour. Estimate uncertainty; when cells are sparse, pool/coarsen to a broader period rather than fabricate precise forecasts. Separate latent harm from observed reports because reporting propensity changes by clock and awareness.

## 6. Economic model

Reference offline package: `packages/temporal-analytics/src/capacity.ts`; calculations are **assumptions**, not live invoices.

~~~text
AI model cost = messages × routedFraction × inputTokensPerRouted × publishedInputPrice
Review processing = messages × humanReviewFraction × secondsPerReview / 3600
Human labor cost = processingHours × fullyLoadedHourlyRate
Total ops cost additionally includes after-hours availability,
coverage redundancy, QA, legal/records obligations, D1/R2/Queues,
networking, incident handling, content review facilities and vendor fees.
~~~

Illustration, not national estimate: 1,000,000 eligible messages/month; 15% routed; 600 input tokens/routed request; hypothetical $0.038/million input tokens => $3.42 model input usage. At 0.13% human-review rate and 90 sec/review, ~32.5 *processing* hours. At $35/hour, ~$1,137.50 processing labor, **before** the cost of continuous human coverage or qualified emergency services.

Image token usage, additional models, retries and provider policies make actual inference higher or different. Review-rate assumption is not a forecast from Gaggle's funnel; their analyzed content and human review include different populations/categories. The real cost center is often staffing, not token usage.

### Prevent economic gaming

- Urgent student safety never runs on an exhausted classroom generative budget. Dedicated safeguarded reserve and failure routing.
- Policy enforcement cannot drop severe alerts to meet spend targets or reclassify urgency using hour/day to reduce staffing.
- Report brigading should be deduplicated for load planning and evidence scoring, **not** a reason to suppress legitimate independent reports.
- Trial nuanced models on synthetic or explicitly authorized evaluation data, not invisible ingestion of K–8 private messages.
- Maintain exact provider receipts (integer USD nanodollars) in current Hall Monitor ledger; never use sampled WAE totals to settle invoices.

## 7. Operational dashboard and on-call playbook

Required:
- Live queue counts by **priority** and oldest-unacknowledged age, with UTC timestamps and district-local clock; no student names.
- Distinguish “no events”, “ingestion unavailable”, and “no qualified human currently on duty.”
- Oncall schedule and tested human acknowledgments, tested escalation/backup and clear after-hours rules.
- A safety incident command view for designated reviewers only, gated separately; the Flightdeck dashboard shows aggregate operations, not evidence.
- Change-event markers (model version, prompt/Noul revision, overlay, feature flag, school holidays, platform outages).
- Never expose small-group or rare high-severity counts in a general teacher dashboard.

## 8. Outcome measurement

Pre-send nudges can improve message tone yet hide unresolved harm. Evaluate independent adjudicated outcomes, rates of student help-seeking, complaints, appeals, harms and unintended chilling effects. Human-review queues should be evaluated on protection, not “alerts cleared.”

Any live experiment with students needs school authorization, guardian/student notices where required, accessibility review, and a safeguard path available in every arm. Model preference/RL feedback must not optimize for fewer reports or user silence.

## 9. Rollout criteria for any after-hours promise

District named safeguarding lead; qualified roster and response agreement; tested late-night alert/acknowledgment/backup flows; emergency reporting protocols; documented privacy purpose and records handling; no model-only severe decisions; scheduled red-team drills; audit of third-party retention/routes; and measured performance in shadow/staff testing. Otherwise product must truthfully describe itself as automated content moderation with **school-hours** follow-up and separately route urgent safety concerns to an available designated service where legally/operationally appropriate.
