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

## Shadow evidence, calibration and the model gate (HM-32)

**Model axis.** `pnpm shadow-report diff --family clairic:shadow` (or `:enforce`) evaluates the
synthetic corpus with a model family switched on for every profile. It layers on top of
`--candidate` overlays when those are given, otherwise on the baseline. The `fake` classifier
includes a Clairic stand-in that answers "nothing found", so the diff isolates routing and cost.
Use `gateway` for real, billed calls on synthetic cases only. Escalations are now counted from the
result routes for every family.

**Calibration.** A study can now declare `"family": "clairic"`. Run `pnpm calibration init
--family clairic --out study.json` to create one. A Clairic study must pin `CLAIRIC_FIELD_PACK`,
which is the field ids and instructions at the evaluator version, digested. Its decisions must be
Clairic fields worded exactly as the evaluator asks them, its cases must be text, and its bands may
name only Clairic models. Blinding works the same as for Clef studies: two or more independent
reviewers, a separate adjudicator, Wilson intervals, and `activation: "not-approved"`. Existing
Clef studies are unchanged.

**Model gate.** `pnpm model-gate --family clairic --calibration flash.json --calibration
full.json --diff diff.json --baseline-report base.json --candidate-report cand.json --enrolled
id,id` checks the evidence against `config/model-gates.json`. The verdict is `eligible-for-enforce`
only when every gate passes:

1. **Release status.** Every model is GA, or `previewWaiverRef` records the owner's waiver.
2. **Calibration.** Every model on the route has measured, held-out metrics. Each cohort and
   decision has at least `minAdjudicatedCases` adjudicated cases, a precision lower bound (Wilson
   95%) of at least `minPrecisionLower95`, and a false-positive-rate upper bound of at most
   `maxFalsePositiveRateUpper95`.
3. **No support regression.** No `support` decision changes in the diff.
4. **Cost.** Measured added cost per 1,000 evaluations is within `maxAddedUsdNanoPer1000`.
5. **Latency.** Measured classifier p95 is within `maxP95Ms`.
6. **Governance.** The enrollment lists every model.

The verdict is always `activation: "not-approved"`. Enforcing still takes the owner's approval, a
profile routing change and, for preview models, the Worker's `HM_MODEL_ENFORCE_WAIVERS`. The
initial thresholds (precision ≥ 0.80, FPR ≤ 0.05, 30 adjudicated cases, $0.15 per 1,000, 800 ms)
are proposals for the owner to confirm.

Clairic's response schema comes from the public model pages. If the live response differs (for
example, in its span encoding), the parser treats it as malformed, which reports uncertainty and
never produces false findings. Validate it with `shadow-report --classifier gateway` on synthetic
cases before any tenant enables Clairic.
