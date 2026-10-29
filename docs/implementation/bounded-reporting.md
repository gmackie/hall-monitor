# Bounded synthetic reporting model (HM-22 / W9 foundation)

The private `telemetry-reporting` package is an inert engineering fixture. Neither Worker nor
any public package imports it. No HTTP reader, live coverage, SQL query, deployment binding or
privacy approval is added. Runtime reads remain gated by HM-21 S0b and the reviewed source
coverage contract. Synthetic counts do not certify what any real tenant did.

## Fixed release and query

The strict schema accepts only `mode: "synthetic"`, one district-wide cohort and 168 local
hour-of-week cells, with server-installed timezone/calendar, cohort/data revisions, evidence cut,
count-validity deadlines, population and explicit fixture policy thresholds. Every numerator and
denominator must have the same cohort and cut, and 0 ≤ F ≤ E. Missing counts are null. Unknown
keys, duplicate cells, invalid zones/dates and non-Monday-aligned 7/28-day windows are rejected.
The dates represent local calendar dates, not a claim of 168 chronological hours across DST.
Projection withholds a window until its local end date has passed. Its clock comes from the
trusted caller, never a query parameter; fixture APIs are not security boundaries for arbitrary
in-process code that can replace the source snapshot or server clock.

The only query is `{releaseId}`. There are no browser-controlled tenant, grade, source, class,
hour range, SQL, total, rolling date window or drilldown filters. A release is one flat partition;
no parent totals expose the suppressed children. Exact chronology is deliberately absent from
this first fixture; the eventual live adapter needs the W8 time/coverage semantics.

## Disclosure projection

Unknown population, insufficient cohort population or positive exposure below the configured
threshold withholds cell values. Candidate rate also requires both F and E−F to meet the fixture
threshold: the complementary class cannot be recovered from a tiny remainder. Those thresholds
are operator-supplied synthetic inputs, not approved production policy. A qualified zero E is
distinct from missing data, while E=0 always has a null rate. Incomplete coverage, unavailable
sources and expired counts remain distinct states and never manufacture zero.

Only measured fixture values are returned, with explicit `synthetic` and `not-approved` labels.
Candidate rates use their matching E; no absolute candidate count, population, raw identifiers,
delivery keys or evidence pointers leave the projection. Reports/cases/urgent queue/cost and
live coverage are advertised unavailable. CSV consumes the same already-redacted DTO as the
screen, uses the same order and nulls, and has no extra totals or alternate cohort.

## Differencing and replay limits

The immutable release catalog remembers all installed partitions, even expired ones. Identical
installation is idempotent; changing an installed identity is refused. It rejects overlapping
7/28-day windows for a tenant, alternate corrected revisions and timezone/calendar changes.
Adjacent nonoverlapping weeks are permitted. At 32 distinct releases the fixture enters a
terminal capacity state; it never forgets a release to authorize a new differencing query.

This is a conservative prototype: it does not publish successive live corrections. A future
correction/disclosure policy must analyze cross-release differences before widening it. A
production service must durably reserve and retain release history before disclosing a value;
rebuilding a fresh in-memory catalog is not a safe reset. The package supplies no proof against
external auxiliary information, colluding sources or arbitrary population composition.

The fixture reader signs a dedicated audience/domain, tenant, district-operator role,
`analytics:read`, issuer and single-use nonce. Writer delivery objects confer no read privilege.
Signature, audience/issuer/time and role/tenant failures are denied with fixed codes. Nonces are
consumed once, including concurrent reads; 1024 nonces cause terminal refusal rather than unsafe
eviction. The service has no HTTP handler. A real implementation must reuse verified identity and
durable anti-replay infrastructure; fixture signing helpers and in-memory nonce state must not
be deployed as a real issuer or durability claim.

## Remaining runtime acceptance

The source verifier must provide the exact cohort/time cut and irreversible count-validity
horizon, with approved retention and complete coverage or explicit unavailability. The current
receiver still reports coverage unavailable. Privacy owners must approve populations, thresholds,
release/correction policy and reader roles. Then implement dedicated reader authentication,
durable release/replay storage, internal route and source adapters, target deployment and
authenticated tests. Flightdeck must consume the same approved DTO from its own authenticated
server. HM-22 remains open through those gates and production verification.
