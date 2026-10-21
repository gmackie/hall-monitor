// Runs the Hall Monitor rollback drill (docs/launch/rollback-drill.md) against the real Worker in
// the workerd test harness (vitest pool workers), so it needs no deployment or Cloudflare account:
//
//   1. an unavailable classifier holds student traffic (fail closed), even for a shadow tenant;
//   2. pinning and rolling back a policy revision produces exactly the decision diff that
//      `pnpm shadow-report diff` predicts over the same synthetic corpus;
//   3. an idempotent replay survives a Durable Object restart without re-evaluating or re-billing.
//
// Usage: pnpm rollback-drill [--out drill-record.json]
// The record is content-free: step names, outcomes, durations, the commit and when it ran.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DRILL_TEST = "apps/worker/test/rollback-drill.test.ts";
const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log("Usage: pnpm rollback-drill [--out drill-record.json]");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "hm-drill-"));
const resultsFile = join(scratch, "results.json");
const ranAt = new Date().toISOString();
const run = spawnSync("pnpm", ["exec", "vitest", "run", DRILL_TEST, "--reporter=default", "--reporter=json", `--outputFile.json=${resultsFile}`], {
  cwd: root,
  stdio: "inherit",
});

let steps = [];
try {
  const results = JSON.parse(readFileSync(resultsFile, "utf8"));
  steps = results.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ name: test.title, status: test.status, durationMs: Math.round(test.duration ?? 0) })),
  );
} catch {
  // No results file: vitest itself failed to start; reported below.
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
const passed = run.status === 0 && steps.length >= 3 && steps.every((step) => step.status === "passed");
const record = { drill: "hall-monitor-rollback", harness: "workerd (vitest-pool-workers)", ranAt, commit, passed, steps };

console.log(`\nRollback drill ${passed ? "PASSED" : "FAILED"} at ${commit.slice(0, 12)}`);
for (const step of steps) console.log(`  ${step.status === "passed" ? "ok  " : "FAIL"} ${step.name} (${step.durationMs} ms)`);
if (steps.length === 0) console.log("  no drill steps ran");
if (values.out) {
  writeFileSync(values.out, JSON.stringify(record, null, 2) + "\n");
  console.log(`Drill record written to ${values.out}`);
}
process.exit(passed ? 0 : 1);
