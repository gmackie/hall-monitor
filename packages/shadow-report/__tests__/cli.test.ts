import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CliIo, main } from "../src/cli.ts";
import { DecisionDiffReport, ShadowReport } from "../src/index.ts";

/** An in-memory file system and captured output. */
function memoryIo(files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    async readFile(path) {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files[path]!;
    },
    async writeFile(path, text) {
      files[path] = text;
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env,
  };
  return { io, files, out: () => out.join(""), err: () => err.join("") };
}

describe("shadow-report CLI", () => {
  it("writes a JSON report and its Markdown for the selected profile", async () => {
    const m = memoryIo();
    expect(await main(["--profile", "educator", "--out", "report.json", "--markdown", "report.md"], m.io)).toBe(0);
    const report = ShadowReport.parse(JSON.parse(m.files["report.json"]!));
    expect(report.configuration.profiles).toEqual(["educator"]);
    expect(m.files["report.md"]).toContain("# Hall Monitor shadow report");
    expect(m.out()).toBe("");

    const rendered = memoryIo({ "report.json": m.files["report.json"]! });
    expect(await main(["render", "report.json"], rendered.io)).toBe(0);
    expect(rendered.out()).toBe(m.files["report.md"]);
  });

  it("diffs a candidate overlay file against the built-in profiles", async () => {
    const candidate = JSON.stringify({ "student-9-12": { revision: "district-7:4", answerAssistance: "scaffolded" } });
    const m = memoryIo({ "policies/candidate.json": candidate });
    expect(await main(["diff", "--candidate", "policies/candidate.json", "--out", "diff.json"], m.io)).toBe(0);
    const diff = DecisionDiffReport.parse(JSON.parse(m.files["diff.json"]!));
    expect(diff.candidate.label).toBe("candidate:candidate.json");
    expect(diff.changes.map((change) => change.id).sort()).toEqual(["integrity-02", "integrity-13"]);
    expect(m.out()).toContain("# Hall Monitor decision diff");
  });

  it("reads synthetic JSONL cases and reports bad lines without their text", async () => {
    const good = JSON.stringify({
      synthetic: true, id: "s-1", kind: "interaction.input", audience: "educator", gradeBand: "9-12", language: "en",
      text: "Plan a lesson on volcanoes.", expectedDecision: "allow", category: "none", group: "benign-academic",
    });
    const m = memoryIo({ "cases.jsonl": good });
    expect(await main(["--cases", "cases.jsonl", "--out", "r.json", "--markdown", "r.md"], m.io)).toBe(0);
    expect(ShadowReport.parse(JSON.parse(m.files["r.json"]!)).corpus).toEqual({ source: "cases.jsonl", cases: 1 });

    const bad = memoryIo({ "cases.jsonl": good.replace('"synthetic":true,', "").replace("volcanoes", "SECRET-SYNTHETIC") });
    expect(await main(["--cases", "cases.jsonl"], bad.io)).toBe(1);
    expect(bad.err()).toContain("line 1: invalid fields: synthetic");
    expect(bad.err()).not.toContain("SECRET-SYNTHETIC");
  });

  it("refuses bad usage with exit code 2", async () => {
    for (const argv of [["diff"], ["frobnicate"], ["--classifier", "gateway"], ["--classifier", "magic"], ["--profile", "no-such-profile"], ["render"], ["--frobnicate"]]) {
      const m = memoryIo();
      expect(await main(argv, m.io), argv.join(" ")).toBe(2);
      expect(m.err()).toContain("Usage:");
    }
    const help = memoryIo();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("pnpm shadow-report diff");
  });

  it("runs under Node as `pnpm shadow-report` does", () => {
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", bin, "--profile", "educator"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("# Hall Monitor shadow report");
  });
});
