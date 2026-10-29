# Calibration engineering harness (HM-8 / W3)

This is offline engineering tooling for synthetic or explicitly licensed material. It supplies
neither human labels nor trained reviewers, measured provider execution, acceptable error limits,
safeguarding approval or a live calibration. The current Worker still uses its existing baseline
thresholds. Student image floors are unchanged. HM-8 remains open for the human panel and signed
measured thresholds; production activation needs its own delivery issue.

## Freeze the study before evaluating the holdout

Run `pnpm calibration init --out dist/calibration/study.json` to create a synthetic draft from the
built-in corpus. Author expectations and rule-based scores are excluded. Every draft case starts
in one development family; the tool deliberately does not randomly split related examples.

A study owner must identify independent families, arrange the development/calibration/held-out
split, review rights for licensed assets and freeze the exact seven pinned decision instructions.
Include supportive reporting, quotation, dissent, code-switching, disability-related expression,
rumor forwarding, false attribution and moderation abuse. The built-in draft does not establish
adequate coverage of those cohorts. No private student chat belongs in the corpus.

Each case declares profile and policy revision, verified grade band, language, text/image modality,
audience and evaluation kind. Image cases reference a synthetic/licensed asset, without importing
image bytes into the report. Distribute image assets with neutral filenames and remove source
metadata before review. No language is inferred from the public evaluation request.

Select candidate low/high bands using development and calibration splits only. Bands are per
decision, provider, exact model and cohort. Missing bands are permitted for reporting, and produce
abstention. Related cases may not cross splits. The strict parser rejects duplicate cases/bands,
unknown keys, unsupported models, changed prompts and an incorrect baseline pack pin.

The canonical SHA-256 study digest covers the cases, family/split assignments, instructions,
applicability, pack and all candidate bands. Commit or otherwise preserve the approved synthetic
study and its digest before unblinding holdout labels or predictions. An in-memory freeze and a
hash are not proof that a person never tuned on the held-out set.

## Independent review

```
pnpm calibration prepare --study dist/calibration/study.json \
  --packet dist/calibration/review.json --key dist/calibration/private-key.json
```

Packet items have random blind identifiers and ordering. They include only the content, cohort
and decision instructions, with no original case IDs, family, split, origin, bands, author labels
or model predictions. Keep the key separate from reviewers. Files use mode 0600 and exclusive
creation: existing files are never overwritten. A failed multi-file operation can leave one
new output; inspect it and use fresh paths to retry.

At least two distinct reviewers independently label each case/decision `positive`, `negative` or
`ambiguous`. Disagreements require an adjudicator who is neither reviewer. Ambiguous decisions,
insufficient review and unresolved disagreement stay unresolved. Reviewer references identify
operator-entered roles; the tool cannot verify training, independence in the real world or identity.

## Import observations and score

The observations object has the following fields (see the exported `CalibrationInput` type):

- `schemaVersion: "1.0"`, `studyRevision`, `studyDigest`, `packetDigest`, `corpusRevision`, `packDigest`;
- `run: {revision, basis: "simulated" | "measured", providerId, modelId}`;
- the private `key` mapping blind IDs to case IDs;
- `reviews: [{reviewerRef, blindId, decisionId, label}]`;
- `adjudications: [{adjudicatorRef, blindId, decisionId, label}]`;
- `predictions: [{blindId, decisionId, score}]`, with `score` in [0,1] or null.

```
pnpm calibration score --study dist/calibration/study.json \
  --observations dist/calibration/observations.json --out dist/calibration/report.json
```

The scorer verifies study and packet digests, one-to-one key assignments and all references. It
rejects duplicate reviews/predictions/adjudications and non-independent adjudication. A changed
key cannot silently reassign already-issued blind observations. Hashes detect inconsistent
artifacts, not a malicious operator who replaces every artifact consistently.

Only held-out cases enter metrics. Reports group by decision and the complete cohort, use bands
for the declared provider/model and show split sizes, confusion counts, disagreements, unresolved
labels and positive/negative abstentions. Scores below low are negative, scores at/above high
positive, and the interval [low, high) abstains. Missing score/band is abstention, never negative.

Precision uses TP/(TP+FP). Recall uses TP/(TP+FN+positive abstentions). Conditional false-positive
rate uses FP/(FP+TN); negative abstentions are shown separately and do not improve it. Coverage
uses classified, adjudicated cases/all held-out cases; label coverage uses adjudicated/all
held-out cases. Zero denominators return null. Every proportion has a Wilson 95% interval. Those
intervals are descriptive for correlated/synthetic samples and do not establish population validity.

`basis` is explicitly operator-declared. Importing `measured` data does not independently verify
provider execution. Every output remains `calibration-candidate`, `activation: "not-approved"`.
Reports contain no text, original case IDs, reviewer identities or individual predictions. Review
the entire supported cohort matrix and missingness before selecting limits or signing anything.

## Classifier seam and later activation

The public Clef package accepts an optional strict `calibration` selection: schemaVersion,
revision, explicit trusted `language` (null is unknown), and rows keyed by provider/model/cohort.
Each row contains the exact ordered question IDs/instructions and its per-question bands. The
package snapshots the selection and exposes its revision in plugin/finding versions.

This low-level structural contract does not authorize a candidate. No Worker environment setting,
artifact loader, approval flag or automatic activation is added. A later activation change must
verify the installed artifact digest, human approval and applicability before supplying this
selection; approvals cannot come from request JSON or the selection itself.

Missing/invalid primary selection returns unavailable/uncertain with zero calls. Missing secondary
selection prevents escalation and preserves primary findings with uncertainty. Successful
escalation uses its own model's bands; failed or denied escalation retains primary bands. Existing
governance still authorizes every actual transfer. Legacy behavior and version remain unchanged
when calibration is absent; global thresholds and calibration cannot both be specified.

Baseline comparison remains available via `pnpm shadow-report --profile student-9-12 --out
dist/calibration/baseline.json --markdown dist/calibration/baseline.md`. Its default classifier
is simulated; that report is a mechanics baseline, not human calibration or live model evidence.
