/** Read-only by construction. Default dry-run never contacts Cloudflare or mutates settings. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { cloudflarePrivacyInspector, runPrivacyPreflight, UNKNOWN_OBSERVATIONS } from "../packages/governance/src/index.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    approval: { type: "string" }, out: { type: "string" }, inspect: { type: "boolean" },
    "dry-run": { type: "boolean" }, "read-only": { type: "boolean" },
  } });
  if (values.approval === undefined || values.out === undefined || (values.inspect && (values["dry-run"] || !values["read-only"]))) {
    console.error("usage: privacy-preflight --approval <file> --out <file> [--dry-run | --inspect --read-only]");
    process.exitCode = 2; return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const inspector = values.inspect && token ? cloudflarePrivacyInspector(token) : { inspect: async () => UNKNOWN_OBSERVATIONS };
  const input: unknown = JSON.parse(await readFile(values.approval, "utf8"));
  const report = await runPrivacyPreflight(input, inspector, Math.floor(Date.now() / 1000));
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, reason: report.reason, mode: values.inspect ? "read-only-inspection" : "dry-run" }));
  process.exitCode = report.result === "verified" ? 0 : 2;
}

main().catch(() => { console.error("privacy preflight could not read input or write its report"); process.exitCode = 1; });
