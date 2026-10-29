import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderSyntheticDemo, runSyntheticDemo } from "../packages/synthetic-demo/src/index.ts";

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (values.out === undefined) throw new Error("missing output");
  const report = await runSyntheticDemo();
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(values.out, "index.html"), renderSyntheticDemo(report));
  console.log("created four fictional walkthroughs; model responses are scripted; no live service connected");
}
main().catch(() => { console.error("synthetic demo failed; supply --out directory"); process.exitCode = 1; });
