// Runs only the synthetic evaluator/outbox/receiver trace in workerd. Never connects to a service.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log("Usage: pnpm reconciliation-drill [--out record.json]");
  process.exit(0);
}
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const revision = git("rev-parse", "HEAD");
const status = git("status", "--porcelain");
const ranAt = new Date().toISOString();
const scratch = mkdtempSync(join(tmpdir(), "hm-reconciliation-"));
const resultsFile = join(scratch, "results.json");
let checks = [], exit = null;
try {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "apps/worker/test/reconciliation.test.ts",
    "--reporter=default", "--reporter=json", `--outputFile.json=${resultsFile}`], { cwd: root, stdio: "inherit" });
  exit = run.status;
  const results = JSON.parse(readFileSync(resultsFile, "utf8"));
  checks = results.testResults.flatMap((file) => file.assertionResults.map((test) => ({
    name: test.title, status: test.status, durationMs: Math.round(test.duration ?? 0),
  })));
} catch {
  // Missing or invalid runner evidence fails closed; never copy free-form errors into the record.
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const commit = revision.status === 0 ? revision.stdout.trim() : "unknown";
const sourceTreeDirty = status.status !== 0 || status.stdout.length > 0;
const passed = exit === 0 && checks.length === 4 && checks.every((check) => check.status === "passed");
const record = { schemaVersion: 1, drill: "hall-monitor-telemetry-reconciliation", mode: "synthetic",
  harness: "workerd (vitest-pool-workers)", ranAt, commit, sourceTreeDirty, passed,
  producerCoverage: "unavailable", productionAcceptance: false, checks };
if (values.out) {
  const path = resolve(values.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}
console.log(`Synthetic reconciliation ${passed ? "PASSED" : "FAILED"}; production acceptance unverified`);
process.exit(passed ? 0 : 1);
