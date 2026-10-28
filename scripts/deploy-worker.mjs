// Deploys apps/worker by hand with `wrangler deploy`, uploading the Worker's per-deployment
// configuration with the new version. ForgeGraph's production deploy does the same with its own
// steps (see .forgegraph.yaml); CI runs this with --dry-run to check the bundle.
//
// The issuer keys, policy overlays, tenant modes and AI Gateway ID differ per deployment, so they
// are not in wrangler.jsonc, whose `vars` every deploy would overwrite. They are Worker secrets
// instead, which a deploy never deletes. Each one set in this process's environment is uploaded
// with the version (`--secrets-file`, applied additively); one left unset keeps its current value.
//
//   node scripts/deploy-worker.mjs [--domain <hostname>] [--dry-run]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const SECRETS = ["HM_DIGEST_KEY", "HM_TRUSTED_ISSUERS", "HM_POLICY_OVERLAYS", "HM_TENANT_MODES", "HM_AI_GATEWAY_ID", "HM_TELEMETRY_ENABLED", "HM_TELEMETRY_TENANTS"];

const { values } = parseArgs({ options: { domain: { type: "string", multiple: true }, "dry-run": { type: "boolean" } } });

const secrets = Object.fromEntries(SECRETS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
const digestKey = secrets.HM_DIGEST_KEY;
if (digestKey !== undefined && digestKey.length < 32) throw new Error("HM_DIGEST_KEY must be at least 32 characters");
for (const name of ["HM_TRUSTED_ISSUERS", "HM_POLICY_OVERLAYS", "HM_TENANT_MODES", "HM_TELEMETRY_TENANTS"]) {
  if (secrets[name] === undefined) continue;
  try {
    JSON.parse(secrets[name]);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}
console.log(`uploading secrets: ${Object.keys(secrets).join(", ") || "none (existing values kept)"}`);

const worker = resolve(import.meta.dirname, "..", "apps", "worker");
const dir = mkdtempSync(join(tmpdir(), "hm-deploy-"));
const secretsFile = join(dir, "secrets.json");
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
try {
  const args = ["exec", "wrangler", "deploy", "--secrets-file", secretsFile];
  for (const domain of values.domain ?? []) args.push("--domain", domain);
  if (values["dry-run"]) args.push("--dry-run");
  execFileSync("pnpm", args, { cwd: worker, stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
