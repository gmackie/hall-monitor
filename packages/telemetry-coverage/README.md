# Experimental telemetry evidence

HM-21 / W8b S0a. This private, Node-only package records synthetic delivery and checkpoint facts.
It has **no runtime importer**, database, network transport or coverage classifier. The receiver
continues to report coverage as unavailable. Nothing here enables collection or admits a tenant.

`parseCoverageRetentionPolicy` accepts the existing eight explicit policy fields plus required
`coverageSeconds`. It delegates base validation to the unchanged live parser and checks
`dedupeSeconds ≤ rollupSeconds ≤ coverageSeconds ≤ gapSeconds`. The live parser still rejects
that ninth field. All fixture durations and approval references are fictional.

`emptyEvidence`, `applyEvidence` and `summarizeEvidence` model assumed-authenticated facts scoped
by tenant, stream and epoch. Delivery identity binds ID, digest and sequence; sequence binds a
delivery identity/digest; checkpoint identity binds its number, digest and accounted sequence.
Identical replay is a no-op. Contradictory variants are retained without choosing a first winner.
Presence and the largest contiguous delivered sequence are observations, not acknowledgment or
time frontiers. A checkpoint behind observed delivery presence does not create a conflict.

The bound is **64 distinct canonical variants across all scopes**. A 65th variant puts the whole
model into a terminal capacity result, with no normal summary. Retries consume no additional
slot. All 720 permutations of the six-fact benign trace converge. State is JSON serializable;
neither JSON serialization nor these tests prove a production storage/restore contract.

The independent test-only completion ledger counts committed work, including undelivered and
late completions. C1–C4 show that the rejected proposal can mistake expired nonzero data for zero,
mistake benign checkpoint delay for rollback, confuse a sequence prefix with a time prefix, and
claim finality before a historical fence violator completes. Passing these tests falsifies those
rules; it does not prove a replacement coverage algorithm.

Run `pnpm --dir packages/telemetry-coverage exec vitest run` after a frozen workspace install.
See [the model note](../../docs/implementation/w8b-evidence-model.md) for verification and the S0b
obligations that must be resolved before receiver or producer integration.
