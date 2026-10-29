# W8b experimental evidence model (S0a)

Owning issue: HM-21, program HM-16. Source baseline: `99d4e299b1ba1a45b6c27f8b25ee5db27687269a`
(merged PR 8, including the canonical CI scratch-storage correction). The dependency excerpt
comparison with reviewed baseline `322734e56743963ffcb6a9a006d73cc8f30a3a82` was empty for runtime
apps, live telemetry contracts, root package/workspace configuration and TypeScript settings.

This is a synthetic evidence experiment, not an enrollment runbook. The package is private and
unreferenced by runtime code. No live parser, API, migration, deployment setting, TTL, fence or
tick changed. HM-21 remains open for proof, runtime coverage and receiver delivery. Retention,
privacy, calibration and actual enrollment approvals remain separate human decisions.

## What the model establishes

The standalone nine-key retention parser checks the base policy and necessary evidence-duration
ordering without changing current v2 admission. The evidence reducer is a finite set of facts,
preserving all conflicting variants under tenant/stream/epoch-scoped identities. It reports
delivery presence and checkpoint identities separately. Capacity is terminal after 64 distinct
variants across scopes; it never discards a conflict while returning an ordinary summary.

The test-only oracle constructs immutable completion ledgers independently of the reducer. It
rejects duplicate identities and contradictory sequence/order/time fixtures. Counts include
undelivered and fence-violating completions. Replayed deliveries never manufacture completions.
Synthetic count-validity witnesses cover read-time expiry, deletion, serialized restart,
long→short→long and short→long policies, and revocation/re-enrollment.

| Witness | Rejected claim | Independent disagreement |
| --- | --- | --- |
| C1 | Live coverage with no visible rollup and no gap means zero | Nonzero and genuinely empty ledgers have identical surviving observations after count expiry |
| C2 | A checkpoint behind contiguous delivery presence means rollback | Legitimate delay and lost acknowledgment leave no identity conflict |
| C3 | An accounted sequence prefix proves all work through a time | A pending committed entry can precede the time cut, including an equal-clock tie |
| C4 | Fence and armed observations make an occurrence bucket final | A request prepared in the bucket can complete later; two suffixes share the observed prefix and differ eventually |

All 720 orders of three deliveries, an identical retry and two checkpoints converge. Conflicting
IDs/digests/sequences, separate scopes, serialization and the 65th-variant boundary are explicit
cases. The S0a exports declare no completeness, verified zero, rates or final frontier. The later
[qualified logical-cut experiment](w8b-as-of-experiment.md) adds a proposed conditional count
model with explicit scope/cut and no finality or runtime approval. It does not complete S0b or
authorize receiver/producer integration.

## S0b obligations before runtime work

1. Persist an irreversible count-validity horizon. Expired, purged or unknown counts cannot be
   reconstructed as zero after a retention extension, restart or replay.
2. Establish a full logical time prefix, including pending commits and equal-clock ties, and
   keep sequence and time from the same authenticated cut.
3. Specify checkpoint identity/conflict history, stale unknown checkpoints and bounded
   tombstones. Delivery presence ahead of a checkpoint is ordinary reordering.
4. Choose proven closure or explicitly qualified **as-of** semantics. Counts and evidence must
   use the same cohort and cut. A later correction does not justify an earlier finality claim.
5. Confirm E membership across evaluation kinds and degraded completions with product/evaluation
   owners. Successfully delivered or fence-admitted work cannot silently become the denominator.
6. Define evidence clock precision, accepted retry horizon, policy/TTL transitions and privacy
   approval for any finer-than-bucket evidence. This model supplies no production duration.
7. Prove bounded compaction preserves taint and identity contradictions. This finite experiment
   approves no production coalescing algorithm.
8. Verify completion uniqueness, transaction/savepoint semantics, durable acknowledgment output
   gating and storage-restore limitations before assigning production sequences.

Positive exact/zero reachability and adversarial negative traces are both required. A constant
unavailable classifier is not that proof. Current runtime coverage remains unavailable until
the obligations are resolved and reviewed; receiver verification must precede producer changes.

## Verification

Validation on source commit `3bafdb3` (29 October 2026), followed only by this evidence-note update:
frozen install passed; 79 focused model tests, 9 unchanged legacy retention tests and all 631
workspace tests in 44 files passed. Lint passed. The standalone drill preserved 84/84 checks.
Evaluator and receiver bundles passed at 928.23 KiB and 53.64 KiB. Whitespace, runtime import
audit and the existing-source comparison passed. The lockfile gained only the new importer
with its workspace link and catalog Vitest entry. No required local check was skipped. Canonical
CI and revision-bound approval are pending publication and are not implied by these local gates.
No deploy, enrollment, live throughput test or platform durability experiment was run.

Commands:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/telemetry-coverage exec vitest run
pnpm --dir packages/telemetry-contracts exec vitest run __tests__/retention-policy.test.ts
pnpm lint
pnpm test
mkdir -p dist
pnpm rollback-drill --out dist/rollback-drill.json
node scripts/deploy-worker.mjs --dry-run
node scripts/deploy-telemetry-worker.mjs --dry-run
git diff --check
rg -n 'telemetry-coverage|telemetryCoverage' apps packages/telemetry-contracts/src packages/telemetry-sink/src scripts
```

The last search must have no matches (exit 1); inspect relative imports as well. The lockfile may
gain only the new importer and workspace link. Compare all existing apps, contracts, sink,
workflows and deploy scripts against the branch baseline. Canonical exact-head CI and a current
approval remain required after publication. No deployment or real enrollment is an S0a criterion.
