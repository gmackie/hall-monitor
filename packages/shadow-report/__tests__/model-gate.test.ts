import { CORPUS } from "@gmacko/hall-monitor-test-fixtures";
import { describe, expect, it } from "vitest";
import { type CalibrationReport, calibrationInterval, diffDecisions, evaluateModelGate, familyVariant, ModelGatePolicy, BUILTIN_VARIANT, CLAIRIC_FIELD_PACK, parseCalibrationStudy } from "../src/index.ts";

const POLICY = ModelGatePolicy.parse({
  schemaVersion: "1.0",
  families: { clairic: { previewWaiverRef: null, minPrecisionLower95: 0.8, maxFalsePositiveRateUpper95: 0.05, minAdjudicatedCases: 30, maxAddedUsdNanoPer1000: "150000000", maxP95Ms: 800 } },
});

function report(modelId: string, tp: number, fp: number, tn: number, basis: "measured" | "simulated" = "measured"): CalibrationReport {
  return {
    schemaVersion: "1.0", kind: "calibration-candidate", studyRevision: "s", corpusRevision: "c", packDigest: CLAIRIC_FIELD_PACK.digest, studyDigest: "d", packetDigest: "p",
    provenance: "operator-declared", basis, runRevision: "r", providerId: "cloudflare-workers-ai", modelId,
    splitCases: { development: 0, calibration: 0, "held-out": 200 }, evaluationSplit: "held-out", activation: "not-approved",
    metrics: [{
      cohort: { profileId: "student-9-12", profileRevision: "builtin-1", gradeBand: "9-12", language: "en", modality: "text", evaluationKind: "interaction.input", audience: "student" },
      decisionId: "personal_identifiers", cases: 200, adjudicated: 200, unresolved: 0, disagreements: 3,
      truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: 0, positiveAbstentions: 0, negativeAbstentions: 0, missingScores: 0, missingBand: 0,
      precision: calibrationInterval(tp, tp + fp), recall: calibrationInterval(tp, tp), falsePositiveRate: calibrationInterval(fp, fp + tn),
      coverage: calibrationInterval(200, 200), labelCoverage: calibrationInterval(200, 200),
    }],
  } as CalibrationReport;
}

describe("model gate", () => {
  it("keeps a preview family in shadow with no evidence, naming every failing gate", () => {
    const verdict = evaluateModelGate({ family: "clairic", policy: POLICY });
    expect(verdict).toMatchObject({ verdict: "shadow-only", activation: "not-approved" });
    expect(verdict.gates.filter((gate) => !gate.pass).map((gate) => gate.id)).toEqual(["release-status", "calibration", "no-support-regression", "cost", "latency", "governance"]);
  });

  it("passes calibration only with measured, adjudicated held-out bounds for every model on the route", () => {
    const good = [report("@cf/cloudflare/clairic-flash", 180, 1, 800), report("@cf/cloudflare/clairic", 180, 1, 800)];
    expect(evaluateModelGate({ family: "clairic", policy: POLICY, calibration: good }).gates.find((gate) => gate.id === "calibration")?.pass).toBe(true);
    expect(evaluateModelGate({ family: "clairic", policy: POLICY, calibration: good.slice(0, 1) }).gates.find((gate) => gate.id === "calibration")?.detail).toContain("@cf/cloudflare/clairic");
    const noisy = [report("@cf/cloudflare/clairic-flash", 100, 40, 60), report("@cf/cloudflare/clairic", 180, 1, 19)];
    expect(evaluateModelGate({ family: "clairic", policy: POLICY, calibration: noisy }).gates.find((gate) => gate.id === "calibration")?.pass).toBe(false);
    const simulated = [report("@cf/cloudflare/clairic-flash", 180, 1, 19, "simulated"), report("@cf/cloudflare/clairic", 180, 1, 19, "simulated")];
    expect(evaluateModelGate({ family: "clairic", policy: POLICY, calibration: simulated }).gates.find((gate) => gate.id === "calibration")?.pass).toBe(false);
  });

  it("checks the support transitions of a family diff and the enrollment", async () => {
    const diff = await diffDecisions({ source: "builtin-slice", cases: CORPUS.slice(0, 12) }, BUILTIN_VARIANT, familyVariant("clairic", "enforce"), { classifier: { kind: "fake" } });
    const verdict = evaluateModelGate({ family: "clairic", policy: POLICY, diff, enrolledModels: ["@cf/cloudflare/clairic-flash", "@cf/cloudflare/clairic"] });
    expect(verdict.gates.find((gate) => gate.id === "no-support-regression")?.pass).toBe(true);
    expect(verdict.gates.find((gate) => gate.id === "governance")?.pass).toBe(true);
  });
});

describe("Clairic calibration studies", () => {
  it("accepts a Clairic study pinned to the field pack and refuses mismatched wording or models", () => {
    const study = {
      schemaVersion: "1.0", revision: "clairic-study-1", corpusRevision: "synthetic-1", family: "clairic", pack: CLAIRIC_FIELD_PACK,
      decisions: [{ id: "personal_identifiers", textInstructions: "Any names?", imageInstructions: "Any names?" }],
      cases: [{ id: "c1", familyId: "f1", split: "held-out", origin: { kind: "synthetic" }, content: { type: "text", text: "Synthetic text" },
        cohort: { profileId: "student-9-12", profileRevision: "builtin-1", gradeBand: "9-12", language: "en", modality: "text", evaluationKind: "interaction.input", audience: "student" } }],
      bands: [] as unknown[],
    };
    expect(() => parseCalibrationStudy(study)).toThrow("calibration pack mismatch");
    const wording = "Every detail that identifies a real private person: full names, usernames or handles, home or street addresses, phone numbers, email addresses, school names together with a class or grade, or account numbers. Exclude public figures and fictional characters.";
    study.decisions = [{ id: "personal_identifiers", textInstructions: wording, imageInstructions: wording }];
    expect(parseCalibrationStudy(study).family).toBe("clairic");
    study.bands = [{ decisionId: "personal_identifiers", cohort: study.cases[0]!.cohort, providerId: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef", band: { low: 0.3, high: 0.8 } }];
    expect(() => parseCalibrationStudy(study)).toThrow("invalid calibration study");
  });
});
