# W2: decision-pack registry

HM-23 implements a private, source-installed registry. It does not calibrate Clef, choose a
student profile, approve a provider or enroll a school. The baseline preserves classifier 1.1.0
and the exact seven text and image questions. Thresholds, severities, escalation, uncertainty,
cost receipts, policy floors and student image holds are unchanged.

`packages/noul-registry` parses schema 1.0 with strict keys, explicit definition versions,
positive/negative criteria, required context, evaluation kinds, modalities, provider/model
support, fixture revision and ownership/provenance. Definitions must match the ordered manifest
exactly. Parsed objects and generated questions are detached from caller input and recursively
frozen. The descriptive negative criteria remain unvalidated; they are neither additional
model instructions nor human ground-truth labels. The accountable role's assignment is pending.

The pack's SHA-256 binds the complete parsed content, including metadata, under the domain
`hall-monitor/decision-pack/v1\n`. Object keys are sorted; array order and string bytes are
significant. The source pin is independent of the computed hash, so modifying a prompt without
deliberately updating the pin fails installation. A trusted source pin is not a digital signature
or proof of institutional authorization. No remote pack or request-supplied pack is loaded.

The public Clef package exports a structural adapter and keeps its existing default constants.
It imports no private package. The private registry depends on Clef, and the private Worker
depends on the registry. The seven-package release allowlist and versions remain unchanged.

## Deployment selection

Unset `HM_DECISION_PACK` selects the source-pinned `clef-baseline@1.0.0`:

```json
{"id":"clef-baseline","version":"1.0.0","digest":"sha256:42ce98e8c39dc3f368e4e21a516bbb2ac6cd1f278daf272f240da0fd8553ac41"}
```

An explicit setting must contain exactly those pin fields and refer to an installed pack. Blank,
malformed, unknown-version and wrong-digest settings do not fall back. The server checks both
primary and escalation models, text/image support, every served evaluation kind and required
context before supplying a classifier. An invalid pin reports `decisionPack:false` and 503 on
authenticated readiness; no inference runs. Evaluations retain the existing classifier-unavailable
policy behavior, including the required student hold and independent deterministic support path.
An authenticated capabilities response reports the classifier disabled. Only the fixed variable
name is logged on configuration failure. Configuration cache entries include the whole setting.

The deployment helper forwards this optional JSON setting additively as a secret. This change
does not set it in production. A future pack needs a new version, fixed pin, compatibility tests,
HM-8 calibration evidence and explicit policy/deployment review. Only the baseline is installed
here, and its classifier revision therefore retains the same meaning and bundle revision.

## Verification

An independent golden fixture copied from pre-W2 source `99d4e29` checks exact text/image
questions, request bytes, output parsing and missing-score uncertainty. Registry tests cover
metadata/prompt tampering, identity/version/ref mismatches, duplicates, immutable aliases,
unsupported categories/modalities/providers/models, applicability and context. Worker harness
tests check valid pins, cache changes, no inference for invalid pins, required holds, content-free
logs and readiness. Run focused tests, the full suite, lint, the rollback drill, both bundles and
`node scripts/pack-release.mjs` before publishing. Packing publishes nothing.
