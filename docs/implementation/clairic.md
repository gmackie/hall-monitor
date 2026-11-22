# HM-31: model-family routing and the Clairic extraction evaluator

The owner's request named a "claire" model. No model by that name exists in the Workers AI catalog;
the owner confirmed they meant **Clairic**, Cloudflare's typed extraction family:

- `@cf/cloudflare/clairic`: preview since 2026-10-19
- `@cf/cloudflare/clairic-flash`: early research preview

Clef estimates how likely each category is. Clairic extracts typed values from the text and
reports, for each one, a confidence, a probability that the value is null, and the source spans.
Hall Monitor uses Clairic **beside** Clef, never instead of it, for the evidence Clef can't give:

| Field(s) | Kinds | Finding (when confident) |
|---|---|---|
| `personal_identifiers`: list of identifying details | every text kind | `clairic.personal_identifier` (privacy). `hold` for students, `info` otherwise. Spans go in `evidence`. |
| `stated_answers` + `reveals_answer` (answer key required) | `interaction.output`, `assessment.evaluator-result` | `clairic.answer_leakage` (academic-integrity), with the stated-answer spans |
| `stated_score`, `states_pass`, `score_matches_verdict` | `assessment.evaluator-result` | `clairic.evaluator_inconsistent` (quality, `hold`) when the score, verdict and reasons disagree. Hall Monitor still never grades. |
| `factual_claims` | `content.candidate` | `clairic.claims` (quality, `info`): located claims for a reviewer to verify |

Findings carry spans and evidence, never the extracted text. All Clairic findings reuse existing
categories, so 0.2.0–0.4.0 clients keep parsing results. `state` is the evaluated text only, so
spans index into it. The answer key goes into the field instructions. Spans outside the text are
dropped. Clairic reads text only; images and digests are skipped with `content_not_supported` or
`digest_content`.

## Routing

`PolicyProfile.routing` sets, for each family (`clef`, `clairic`), `enabled`, `mode` (`enforce` or
`shadow`) and an optional `kinds` list. It's part of the profile revision. When a profile has no
routing, the behaviour is the same as before routing existed: Clef runs on every kind and decides,
and Clairic is off. Overlays stay tighten-only:

- A family can be switched on but not off.
- A family can move from `shadow` to `enforce` but not back.
- A family can gain evaluation kinds but not lose them. A family the floor leaves off can be
  switched on for any set of kinds.

The core runs every routed family in parallel:

- **`enforce` families** produce findings and signals for the decision.
- **`shadow` families** record their findings in `route.classifiers[].shadowFindings`. Their
  failures are ignored, and their provider attempts are still on the receipt, because they were
  billed.

With Clef alone, the evaluator bundle revision is unchanged (`base-1.0.1:clef-1.1.0`). Each routed
family appends `:<id>-<version>`.

**The preview gate.** The Worker clamps any family whose models are all `preview` to `shadow`,
even when a profile asks to enforce it, unless `HM_MODEL_ENFORCE_WAIVERS` (a JSON array of family
names) records the owner's waiver. Today this applies to Clairic. Clamping only removes findings
that never decided before routing existed, so it can't weaken Clef enforcement on any floor.

**Governance.** Every Clairic call passes the same `authorizeModel` check as Clef.
`Route.modelIds` now accepts the two Clairic ids. An enrollment that lists only Clef models keeps
denying Clairic, which shows up as `skipReason: "not_authorized"`.

## Escalation and calibration

Clairic-flash runs first. When any answer's confidence falls in the uncertain band and the profile
enables escalation, Clairic escalates once to `clairic`, with `escalationReason: "low_confidence"`.
If the escalation fails or is denied, the primary answers are kept and the result is marked
uncertain. The band is `UNCALIBRATED_CLAIRIC_THRESHOLDS {0.35, 0.75}`, a placeholder like Clef's
until held-out calibration replaces it per cohort.

## Pricing

`packages/costing/src/cloudflare-2026-11-22.ts` (`PRICE_BOOK_CLOUDFLARE_2026_11_22`, which the
Worker now uses as `CURRENT_PRICE_BOOK`) carries every 2026-10-20 rate forward and adds:

- `clairic`: $0.10 per million input tokens until 2026-12-01 (the launch price), then $0.24. The
  two rates are effective-dated.
- `clairic-flash`: $0.10 per million input tokens.

Output tokens are free. Every `text` field is a separate provider pass that bills the full input
again. Receipts use the provider-reported input tokens, which include every pass. A call without
reported usage is recorded with unknown cost and is never estimated. The 2026-10-20 book is
unchanged.

`MODEL_REGISTRY` lists every routable model with its family, role, status, context and modalities.
`GET /v1/capabilities` reports it as `models`.

## Not yet done

The following waits for HM-32:

- the `shadow-report` model axis
- the calibration harness for Clairic studies
- `pnpm model-gate`

Clairic's response schema comes from the public model pages. If the live response differs (for
example, in its span encoding), the parser treats the response as malformed, which reports
uncertainty and never produces false findings. Validate it against real responses on synthetic
cases with `shadow-report --classifier gateway` before any tenant enables Clairic.
