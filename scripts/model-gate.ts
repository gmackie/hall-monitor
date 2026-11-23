/**
 * `pnpm model-gate --family clairic [evidence…]`: checks a model family against the owner's gates
 * in config/model-gates.json and prints the verdict. Advisory only: it never activates a model.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { evaluateModelGate, ModelGatePolicy } from "../packages/shadow-report/src/model-gate.ts";

async function json(path: string | undefined): Promise<any> {
  return path === undefined ? undefined : JSON.parse(await readFile(path, "utf8"));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    family: { type: "string" },
    policy: { type: "string", default: "config/model-gates.json" },
    calibration: { type: "string", multiple: true },
    diff: { type: "string" },
    "baseline-report": { type: "string" },
    "candidate-report": { type: "string" },
    enrolled: { type: "string" },
  } });
  if (values.family !== "clef" && values.family !== "clairic") {
    console.error("usage: pnpm model-gate --family <clef|clairic> [--calibration report.json]… [--diff diff.json] [--baseline-report r.json --candidate-report r.json] [--enrolled id,id]");
    return 2;
  }
  const verdict = evaluateModelGate({
    family: values.family,
    policy: ModelGatePolicy.parse(await json(values.policy)),
    calibration: await Promise.all((values.calibration ?? []).map((path) => json(path))),
    diff: await json(values.diff),
    baselineReport: await json(values["baseline-report"]),
    candidateReport: await json(values["candidate-report"]),
    ...(values.enrolled === undefined ? {} : { enrolledModels: values.enrolled.split(",").filter(Boolean) }),
  });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.verdict === "eligible-for-enforce" ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  console.error(`model-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
