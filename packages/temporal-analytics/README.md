# Temporal analytics primitives (experimental)

**Offline / synthetic-only prototype.** This package does **not** instrument the production Worker, ingest student data, call an AI provider, store incidents or publish analytics. It is not a FERPA/COPPA privacy attestation. It provides strict content-free input checks, institution-local hour-of-week bucketing with DST fold awareness, event-type aggregation, defensive low-count display suppression, WAE sample-weight handling and scenario-cost math and synthetic, shift-aware nonpreemptive human-review queue simulation.

## Scope

An admitted metric has only a UTC occurrence timestamp, fixed stage/category/priority/modality/band/source/calendar enumerations, and an optional bounded review duration. Unexpected fields, including student ID, case ID, message ID, text, arbitrary username and source snippets, are rejected. A source system must deduplicate and authenticate events before using this library. The district's official calendar, not a student's IP or location, provides the timezone and instructional-day status.

The aggregateHourOfWeek output is a 168-cell **display grouping**, not proof that a DST-transition week contains exactly 168 elapsed hours. The protected underlying hourly aggregate must retain UTC offset for exact chronology. Fall-back 1 AM events share a visual cell; spring-forward 2 AM can be absent.

flagRatePerThousand assumes exactly one content_evaluated per eligible submission and at most one candidate_flagged per submission. The same cohort, time window and calendar coverage must be used for numerator and denominator. Missing denominator means unavailable, not zero.

weightedAnalyticsEngineCount illustrates Cloudflare Analytics Engine's use of _sample_interval for sampled estimates, never exact safeguarding case counts.

suppressRareCell is NOT a privacy/anonymity guarantee. Cross-query differencing, small districts and longitudinal exports need broader review and protections. No external analytics publication is enabled.

## Tests

Part of workspace test suite; synthetic test cases cover schema rejection, DST spring/fall, local dates, time aggregation, suppression, cost arithmetic, urgency-first dispatch, after-hours staffing gaps and censored queue jobs.

## Design

See [temporal LLD](../../docs/design/temporal-analytics.md), [metric definitions](../../docs/design/temporal-metrics.md), [event APIs](../../docs/design/temporal-events-and-api.md), and [Flightdeck](../../docs/design/flightdeck-operations.md). Actual district-authorized collection and review services are not implemented.
