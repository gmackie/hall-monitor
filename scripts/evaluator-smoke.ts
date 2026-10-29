import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { runSyntheticEvaluatorAcceptance } from "../packages/evaluator-acceptance/src/index.ts";

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, commit: { type: "string" }, deployment: { type: "string" },
    "credentials-file": { type: "string" }, out: { type: "string" } } });
  if (!values.url || !values.commit || !values.deployment || !values["credentials-file"] || !values.out) throw new Error("missing options");
  const credentials = await readFile(values["credentials-file"], "utf8");
  if (Buffer.byteLength(credentials) > 65_536) throw new Error("credentials too large");
  const evidence = await runSyntheticEvaluatorAcceptance({ target: { url: values.url, expectedCommit: values.commit, deploymentId: values.deployment }, credentials: JSON.parse(credentials) });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(`Synthetic evaluator smoke ${evidence.passed ? "PASSED" : "FAILED"}; ${evidence.checks.length} phases recorded`);
  process.exitCode = evidence.passed ? 0 : 1;
}
main().catch(() => { console.error("Evaluator smoke failed; verify target and private credential-file options"); process.exitCode = 1; });
