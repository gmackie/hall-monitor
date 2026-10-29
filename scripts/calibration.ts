/** Offline study/packet/report tooling. Never invokes a provider or fills human labels. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { BASELINE_DECISION_PACK, BASELINE_DECISION_PACK_PIN } from "../packages/noul-registry/src/index.ts";
import { CORPUS, fixtureProfileId } from "../packages/test-fixtures/src/index.ts";
import { parseCalibrationStudy, prepareCalibrationPacket, scoreCalibration } from "../packages/shadow-report/src/calibration.ts";

async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    study: { type: "string" }, observations: { type: "string" }, out: { type: "string" },
    packet: { type: "string" }, key: { type: "string" },
  } });
  const command = positionals[0];
  if (positionals.length !== 1) throw new Error("usage");
  if (command === "init" && values.out !== undefined) {
    const study = parseCalibrationStudy({ schemaVersion: "1.0", revision: "draft-study-1", corpusRevision: "synthetic-corpus-v1",
      pack: BASELINE_DECISION_PACK_PIN,
      decisions: BASELINE_DECISION_PACK.definitions.map((d) => ({ id: d.id,
        textInstructions: d.questions.find((q) => q.modality === "text")!.instructions,
        imageInstructions: d.questions.find((q) => q.modality === "image")!.instructions })),
      // No automatic split of related examples: an owner must define independent families first.
      cases: CORPUS.map((c) => ({ id: c.id, familyId: "builtin-corpus-v1", split: "development", origin: { kind: "synthetic" },
        cohort: { profileId: fixtureProfileId(c), profileRevision: "builtin-1", gradeBand: c.gradeBand, language: c.language, modality: "text",
          evaluationKind: c.kind, audience: c.audience }, content: { type: "text", text: c.text } })), bands: [] });
    await save(values.out, study);
    console.log("created synthetic draft: partition families and select bands before freezing; no labels or approvals supplied"); return;
  }
  if (values.study === undefined) throw new Error("usage");
  const study: unknown = JSON.parse(await readFile(values.study, "utf8"));
  if (command === "prepare" && values.packet !== undefined && values.key !== undefined) {
    if (resolve(values.packet) === resolve(values.key)) throw new Error("usage");
    const { packet, key } = prepareCalibrationPacket(study, () => `blind_${randomUUID().replace(/-/g, "")}`);
    await save(values.packet, packet); await save(values.key, key);
    console.log("created blinded packet and separate private key; reviewers must not receive the key"); return;
  }
  if (command === "score" && values.observations !== undefined && values.out !== undefined) {
    const observations: unknown = JSON.parse(await readFile(values.observations, "utf8"));
    const report = scoreCalibration(study, observations);
    await save(values.out, report);
    console.log(JSON.stringify({ kind: report.kind, basis: report.basis, activation: report.activation, cohorts: report.metrics.length })); return;
  }
  throw new Error("usage");
}
main().catch(() => {
  console.error("calibration input/operation rejected; use init --out, prepare --study --packet --key, or score --study --observations --out");
  process.exitCode = 1;
});
