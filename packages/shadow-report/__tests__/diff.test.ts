import { resolveDecision } from "@gmacko/hall-monitor-policy";
import { CORPUS } from "@gmacko/hall-monitor-test-fixtures";
import { describe, expect, it } from "vitest";
import { BUILTIN_CASES, BUILTIN_VARIANT, DecisionDiffReport, diffDecisions, overlayVariant, renderDiffMarkdown, resolverVariant } from "../src/index.ts";

const clock = () => new Date("2026-10-21T00:00:00.000Z");
const TEXTS = CORPUS.map((fixture) => fixture.text).filter((text) => text.length >= 20);

/** A candidate revision that makes every non-scaffolded profile scaffold answers. */
const SCAFFOLD_EVERYWHERE = {
  educator: { revision: "district-7:4", answerAssistance: "scaffolded", inputModeration: "off" },
  "student-9-12": { revision: "district-7:4", answerAssistance: "scaffolded" },
};

describe("decision diff between policy revisions", () => {
  it("reports no change between identical variants", async () => {
    const report = await diffDecisions(BUILTIN_CASES, BUILTIN_VARIANT, overlayVariant("same", {}), { clock });
    expect(report).toMatchObject({ changed: 0, reasonCodesOnlyChanged: 0, transitions: {}, byReasonCode: {}, changes: [], errors: [] });
    expect(report.agreement.baseline).toEqual(report.agreement.candidate);
  });

  it("lists every changed case by transition and reason code, clamping weakening fields", async () => {
    const candidate = overlayVariant("candidate", SCAFFOLD_EVERYWHERE);
    expect(candidate.clampedFields).toEqual(["educator.inputModeration"]);
    const report = await diffDecisions(BUILTIN_CASES, BUILTIN_VARIANT, candidate, { clock });
    expect(DecisionDiffReport.parse(report)).toEqual(report);
    expect(report.candidate).toMatchObject({ label: "candidate", clampedFields: ["educator.inputModeration"] });
    expect(report.candidate.policyRevisions).toMatchObject({ educator: "district-7:4", "student-9-12": "district-7:4", "student-6-8": "builtin-1" });
    const ids = report.changes.map((change) => change.id).sort();
    expect(ids).toEqual(["integrity-02", "integrity-07", "integrity-13"]);
    expect(report.transitions).toEqual({ "allow->coach": 3 });
    expect(report.byReasonCode).toEqual({ "academic_integrity.direct_answer_request": { cases: ids, added: [], removed: [] } });
    expect(report.changes.every((change) => change.from === "allow" && change.to === "coach" && change.text === undefined)).toBe(true);
    expect(report.agreement.candidate.agreed).toBe(report.agreement.baseline.agreed - 3);
  });

  it("diffs resolver versions over the same corpus", async () => {
    const stricter = resolverVariant(
      "resolver-candidate",
      (...args) => {
        const resolution = resolveDecision(...args);
        return { ...resolution, decision: resolution.decision === "coach" ? "hold" : resolution.decision, resolverVersion: "resolver-candidate" };
      },
      "resolver-candidate",
    );
    const report = await diffDecisions(BUILTIN_CASES, BUILTIN_VARIANT, stricter, { clock });
    expect(report.candidate.resolverVersion).toBe("resolver-candidate");
    expect(Object.keys(report.transitions)).toEqual(["coach->hold"]);
    expect(report.changed).toBeGreaterThan(0);
  });

  it("refuses overlays for unknown profiles", () => {
    expect(() => overlayVariant("bad", { "no-such-profile": { revision: "r1" } })).toThrow("unknown profile");
  });

  it("is content-free unless text is requested, and renders as Markdown", async () => {
    const candidate = overlayVariant("candidate", SCAFFOLD_EVERYWHERE);
    const report = await diffDecisions(BUILTIN_CASES, BUILTIN_VARIANT, candidate, { clock });
    const markdown = renderDiffMarkdown(report);
    for (const text of TEXTS) expect(JSON.stringify(report) + markdown).not.toContain(text);
    expect(markdown).toContain("**3 decisions changed**");
    expect(markdown).toContain("| allow → coach | 3 |");
    const withText = await diffDecisions(BUILTIN_CASES, BUILTIN_VARIANT, candidate, { clock, includeText: true });
    expect(withText.changes.every((change) => change.text === CORPUS.find((fixture) => fixture.id === change.id)!.text)).toBe(true);
  });
});
