// Checks the telemetry receiver's bundle and posture. It is a DRY RUN ONLY gate (HM-21): there is no
// live-deploy path in this script, because the receiver must not be deployed or enrolled until its
// retention and enrolment are separately approved. CI runs it next to the evaluator bundle check.
//
//   node scripts/deploy-telemetry-worker.mjs --dry-run
//
// It fails if the configuration stops being internal-only (a route, workers.dev, a service or
// storage binding it should not have) or if the bundle no longer contains the aggregate store.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
if (!values["dry-run"]) {
  console.error("deploy-telemetry-worker.mjs only supports --dry-run: the receiver is not deployed by this repository's tooling yet.");
  process.exit(2);
}

const worker = resolve(import.meta.dirname, "..", "apps", "telemetry-worker");

// wrangler.jsonc has only whole-line // comments; strip them and parse.
const config = JSON.parse(
  readFileSync(join(worker, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);

const problems = [];
if (config.workers_dev !== false) problems.push("workers_dev must be false");
if (config.observability?.enabled !== false) problems.push("observability must be disabled");
for (const key of ["route", "routes", "triggers", "vars", "services", "d1_databases", "r2_buckets", "kv_namespaces", "queues", "analytics_engine_datasets", "ai", "hyperdrive", "vectorize", "tail_consumers", "logpush"]) {
  if (config[key] !== undefined) problems.push(`${key} must not be configured`);
}
const bindings = config.durable_objects?.bindings ?? [];
if (bindings.length !== 1 || bindings[0].name !== "AGGREGATES" || bindings[0].class_name !== "TelemetryAggregateStore") {
  problems.push("the only binding must be the AGGREGATES Durable Object (TelemetryAggregateStore)");
}
const sqlite = (config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
if (!sqlite.includes("TelemetryAggregateStore") || (config.migrations ?? []).some((m) => m.new_classes !== undefined)) {
  problems.push("TelemetryAggregateStore must be a SQLite-backed Durable Object class");
}
if (problems.length > 0) {
  console.error(`telemetry receiver configuration is not internal-only:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const outdir = mkdtempSync(join(tmpdir(), "hm-telemetry-bundle-"));
try {
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir], { cwd: worker, stdio: "inherit" });
  const bundle = readdirSync(outdir).filter((name) => name.endsWith(".js") || name.endsWith(".mjs"));
  const text = bundle.map((name) => readFileSync(join(outdir, name), "utf8")).join("\n");
  for (const needle of ["TelemetryAggregateStore", "hall-monitor-telemetry-v2", "hall-monitor-telemetry-ack-v2", "hall-monitor-telemetry-v1"]) {
    if (!text.includes(needle)) {
      console.error(`telemetry receiver bundle is missing ${needle}`);
      process.exit(1);
    }
  }
  console.log(`telemetry receiver bundle ok (${bundle.length} module(s)); nothing was deployed`);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
