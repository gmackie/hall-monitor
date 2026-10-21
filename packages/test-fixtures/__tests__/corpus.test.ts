import { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { defaultBundle, runPlugins } from "@gmacko/hall-monitor-evaluators";
import { BUILTIN_PROFILES, resolveDecision } from "@gmacko/hall-monitor-policy";
import { beforeAll, describe, expect, it } from "vitest";
import { type CaseResult, CORPUS, type FixtureCase, fixtureProfileId, fixtureRequest, scoreCorpus } from "../src/index.ts";

async function evaluateDeterministically(fixture: FixtureCase): Promise<CaseResult> {
  const request = EvaluationRequest.parse(fixtureRequest(fixture));
  const profile = BUILTIN_PROFILES[fixtureProfileId(fixture)]!;
  const output = await runPlugins(defaultBundle.plugins, request, { profile, signal: new AbortController().signal });
  const resolution = resolveDecision(profile, output.findings, request.context);
  return {
    fixture,
    decision: resolution.decision,
    categories: [...new Set(output.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.category))],
  };
}

describe("synthetic corpus", () => {
  it("has at least 80 uniquely named cases across five languages", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(CORPUS.map((fixture) => fixture.id)).size).toBe(CORPUS.length);
    expect(new Set(CORPUS.map((fixture) => fixture.language))).toEqual(new Set(["en", "es", "fr", "de", "zh"]));
  });

  it("uses only reserved example contact details", () => {
    for (const fixture of CORPUS) {
      for (const email of fixture.text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
        expect(email, fixture.id).toMatch(/@example\.(com|org|net)$/);
      }
      for (const phone of fixture.text.match(/\d{3}[ -]\d{3}[ -]\d{4}/g) ?? []) {
        expect(phone, fixture.id).toMatch(/^555[ -]01\d[ -]\d{4}$/);
      }
    }
  });
});

describe("deterministic bundle over the corpus", () => {
  let results: CaseResult[];
  beforeAll(async () => {
    results = await Promise.all(CORPUS.map(evaluateDeterministically));
  });
  const decided = () => results.filter((result) => !result.fixture.requiresClassifier);

  it("has zero false negatives on must-block cases", () => {
    const misses = decided().filter((result) => result.fixture.expectedDecision === "block" && result.decision !== "block");
    expect(misses.map((result) => `${result.fixture.id} -> ${result.decision}`)).toEqual([]);
  });

  it("has zero false negatives on must-support cases", () => {
    const misses = decided().filter((result) => result.fixture.expectedDecision === "support" && result.decision !== "support");
    expect(misses.map((result) => `${result.fixture.id} -> ${result.decision}`)).toEqual([]);
  });

  it("allows every benign academic, literary, historical and health case", () => {
    const flagged = results.filter(
      (result) => (result.fixture.group === "benign-academic" || result.fixture.group === "sensitive-allowed") && result.decision !== "allow",
    );
    expect(flagged.map((result) => `${result.fixture.id} -> ${result.decision}`)).toEqual([]);
  });

  it("reports precision and recall per category and grade band", () => {
    const score = scoreCorpus(results);
    expect(Object.keys(score.byGradeBand).sort()).toEqual(["3-5", "6-8", "9-12", "K-2"]);
    const format = (value: number | null) => (value === null ? "  n/a" : value.toFixed(2).padStart(5));
    const lines = [
      "category            precision recall   tp  fp  fn",
      ...Object.entries(score.byCategory).map(
        ([category, m]) => `${category.padEnd(20)}${format(m.precision)}    ${format(m.recall)}  ${String(m.truePositives).padStart(3)} ${String(m.falsePositives).padStart(3)} ${String(m.falseNegatives).padStart(3)}`,
      ),
      "grade band   cases precision recall decision-accuracy",
      ...Object.entries(score.byGradeBand).map(
        ([band, m]) => `${band.padEnd(13)}${String(m.cases).padStart(5)} ${format(m.precision)}    ${format(m.recall)}  ${format(m.decisionAccuracy)}`,
      ),
      `mismatches: ${score.mismatches.map((m) => `${m.id} expected ${m.expected} got ${m.actual}${m.requiresClassifier ? " (needs classifier)" : ""}`).join("; ") || "none"}`,
    ];
    console.info(lines.join("\n"));
  });
});

describe("scoreCorpus", () => {
  it("counts per-category positives and predictions", () => {
    const [block, benign] = [CORPUS.find((f) => f.id === "harmful-01")!, CORPUS.find((f) => f.id === "benign-01")!];
    const score = scoreCorpus([
      { fixture: block, decision: "block", categories: ["safety"] },
      { fixture: benign, decision: "hold", categories: ["safety"] },
    ]);
    expect(score.byCategory.safety).toEqual({ truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5, recall: 1 });
    expect(score.mismatches).toEqual([{ id: "benign-01", expected: "allow", actual: "hold", requiresClassifier: false }]);
  });
});
