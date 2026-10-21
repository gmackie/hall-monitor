import { CORPUS } from "@gmacko/hall-monitor-test-fixtures";
import { describe, expect, it } from "vitest";
import { BUILTIN_CASES, parseCasesJsonl, selectCases, ShadowCase } from "../src/index.ts";

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    synthetic: true,
    id: "synthetic-01",
    kind: "interaction.input",
    audience: "student",
    gradeBand: "6-8",
    language: "en",
    text: "SECRET-SYNTHETIC-TEXT how do volcanoes form?",
    expectedDecision: "allow",
    category: "none",
    group: "benign-academic",
    ...overrides,
  });

describe("synthetic case files", () => {
  it("accept every built-in corpus case once it is attested synthetic", () => {
    for (const fixture of CORPUS) expect(ShadowCase.safeParse({ ...fixture, synthetic: true }).success, fixture.id).toBe(true);
  });

  it("parse JSONL, skipping blank lines", () => {
    const set = parseCasesJsonl("cases.jsonl", `${line()}\n\n${line({ id: "synthetic-02", graded: true, answerKey: ["lava"] })}\n`);
    expect(set.source).toBe("cases.jsonl");
    expect(set.cases.map((fixture) => fixture.id)).toEqual(["synthetic-01", "synthetic-02"]);
    expect(set.cases[0]).not.toHaveProperty("synthetic");
    expect(set.cases[1]).toMatchObject({ graded: true, answerKey: ["lava"], note: "" });
  });

  it("refuse lines not attested synthetic, invalid lines and duplicates, naming lines and fields only", () => {
    const failures = [
      [line({ synthetic: undefined }), "line 1: invalid fields: synthetic"],
      [`${line()}\n${line({ gradeBand: "SECRET-SYNTHETIC-TEXT" })}`, "line 2: invalid fields: gradeBand"],
      [`${line()}\n${line()}`, "line 2: duplicate case id"],
      ["{SECRET-SYNTHETIC-TEXT", "line 1: not valid JSON"],
      [line({ extra: "SECRET-SYNTHETIC-TEXT" }), "line 1: invalid fields: (root)"],
      ["\n", "no cases found"],
    ] as const;
    for (const [text, message] of failures) {
      expect(() => parseCasesJsonl("cases.jsonl", text)).toThrow(message);
      try {
        parseCasesJsonl("cases.jsonl", text);
      } catch (error) {
        expect(String(error)).not.toContain("SECRET-SYNTHETIC-TEXT");
      }
    }
  });

  it("select cases by the profile they are evaluated under", () => {
    const educator = selectCases(BUILTIN_CASES, ["educator"]);
    expect(educator.cases.length).toBeGreaterThan(0);
    expect(educator.cases.every((fixture) => fixture.audience === "educator" && fixture.kind !== "content.candidate")).toBe(true);
    expect(selectCases(BUILTIN_CASES, []).cases).toBe(BUILTIN_CASES.cases);
  });
});
