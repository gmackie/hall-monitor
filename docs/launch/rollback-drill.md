# Rollback drill

`pnpm rollback-drill` exercises the recovery paths a launch depends on against the real Worker in
the workerd test harness (Vitest pool workers), so it needs no deployment, account or real data.
The same test (`apps/worker/test/rollback-drill.test.ts`) runs in `pnpm test`, and CI runs the
script on every push. Pass `--out drill.json` to keep a content-free record (steps, outcomes,
durations, commit, time) as evidence for launch checklist item R1.

| Step | What it proves |
|---|---|
| 1. Classifier unavailable | With Workers AI failing, or no AI binding at all, a student-profile request is held (`hall_monitor.unavailable`, degraded `classifier_unavailable`, unknown cost receipted). A shadow-mode tenant without `allowStudentShadow` is still held. Recovery allows the same content again. |
| 2. Policy pin and rollback | With revision `drill:2` live, pinning `drill:1` or the built-in floor is refused (404). Rolling the tenant's configuration back to `drill:1` refuses `drill:2`. The decisions that differ between the two live revisions over the synthetic 9-12 corpus are exactly those `pnpm shadow-report diff` predicts offline. |
| 3. Replay survives restart | After an evaluation, the tenant's Durable Object is aborted (a restart: the instance is discarded, storage kept). Repeating the request replays the identical stored result with `idempotent-replayed: true`, without another classifier call, and the receipt is still readable. |

What it does not cover, and remains a human step (checklist R2): rolling back a real deployment
(`wrangler rollback` or redeploying the previous release), restoring a previous configuration in
the target account, and confirming each product's behaviour while Hall Monitor is unavailable.
Record those in the signed checklist with the drill record for the same commit.
