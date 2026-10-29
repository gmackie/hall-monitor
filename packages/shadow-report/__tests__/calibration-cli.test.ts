import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("creates a label-free synthetic draft and separate private packet/key without overwriting evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-calibration-"));
  const script = fileURLToPath(new URL("../../../scripts/calibration.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", script, ...args],
    { encoding: "utf8", timeout: 10_000 });
  try {
    const study = join(dir, "study.json"), packet = join(dir, "packet.json"), key = join(dir, "key.json");
    const init = run("init", "--out", study);
    expect(init.status, init.stderr).toBe(0);
    const draft = JSON.parse(readFileSync(study, "utf8"));
    expect(draft.bands).toEqual([]);
    expect(draft.cases.every((c: { split: string }) => c.split === "development")).toBe(true);
    expect(readFileSync(study, "utf8")).not.toContain("expectedDecision");
    const prepare = run("prepare", "--study", study, "--packet", packet, "--key", key);
    expect(prepare.status, prepare.stderr).toBe(0);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(key, "utf8")))).toHaveLength(draft.cases.length);
    expect(readFileSync(packet, "utf8")).not.toContain('"familyId"');
    const before = readFileSync(study, "utf8");
    expect(run("init", "--out", study).status).toBe(1);
    expect(readFileSync(study, "utf8")).toBe(before);
    const alias = run("prepare", "--study", study, "--packet", join(dir, "same.json"), "--key", join(dir, ".", "same.json"));
    expect(alias.status).toBe(1);
    expect(alias.stderr).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
