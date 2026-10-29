import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import { BASELINE_DECISION_PACK, BASELINE_DECISION_PACK_PIN } from "@gmacko/hall-monitor-noul-registry";
import { describe, expect, it } from "vitest";
import { calibrationInterval, calibrationStudyDigest, parseCalibrationStudy, prepareCalibrationPacket, scoreCalibration,
  type CalibrationInput, type CalibrationStudy } from "../src/calibration.ts";

function study(count = 1): CalibrationStudy {
  const cohort = { profileId: "student-9-12", profileRevision: "builtin-1", gradeBand: "9-12" as const, language: "en",
    modality: "text" as const, audience: "student" as const, evaluationKind: "interaction.input" as const };
  return { schemaVersion: "1.0", revision: "study-1", corpusRevision: "corpus-1", pack: { ...BASELINE_DECISION_PACK_PIN },
    decisions: BASELINE_DECISION_PACK.definitions.map((d) => ({ id: d.id,
      textInstructions: d.questions.find((q) => q.modality === "text")!.instructions,
      imageInstructions: d.questions.find((q) => q.modality === "image")!.instructions })),
    cases: Array.from({ length: count }, (_, i) => ({ id: `source_${i}`, familyId: `family_${i}`, split: "held-out", origin: { kind: "synthetic" },
      cohort: { ...cohort }, content: { type: "text", text: `Fictional example ${i}.` } })),
    bands: BASELINE_DECISION_PACK.definitions.map((d) => ({ decisionId: d.id, cohort: { ...cohort },
      providerId: CLOUDFLARE_WORKERS_AI, modelId: CLEF_FLASH_MODEL, band: { low: 0.35, high: 0.75 } })) };
}
function observations(s: CalibrationStudy): CalibrationInput {
  let next = 0;
  const { packet, key } = prepareCalibrationPacket(s, () => `blind_${next++}`);
  return { schemaVersion: "1.0", studyRevision: s.revision, studyDigest: calibrationStudyDigest(s), packetDigest: packet.packetDigest,
    corpusRevision: s.corpusRevision, packDigest: s.pack.digest,
    run: { revision: "run-1", basis: "simulated", providerId: CLOUDFLARE_WORKERS_AI, modelId: CLEF_FLASH_MODEL }, key: { ...key },
    reviews: packet.items.flatMap((c) => c.decisions.flatMap((d) => ["reviewer_1", "reviewer_2"].map((reviewerRef) => ({
      reviewerRef, blindId: c.blindId, decisionId: d.id, label: "negative" as const })))),
    adjudications: [], predictions: packet.items.flatMap((c) => c.decisions.map((d) => ({ blindId: c.blindId, decisionId: d.id, score: 0.1 }))) };
}
const metric = (s: CalibrationStudy, i: CalibrationInput) => scoreCalibration(s, i).metrics.find((m) => m.decisionId === "self_harm")!;

describe("frozen calibration study and blinded packet", () => {
  it("pins all existing decision instructions and recursively freezes the parsed study", () => {
    const raw = study(), parsed = parseCalibrationStudy(raw);
    expect(Object.isFrozen(parsed.cases[0]!.cohort)).toBe(true);
    raw.cases[0]!.content = { type: "text", text: "changed draft" };
    expect(parsed.cases[0]!.content).not.toEqual(raw.cases[0]!.content);
    const wrong = study(); wrong.decisions[0]!.textInstructions += "changed";
    expect(() => parseCalibrationStudy(wrong)).toThrow("pack mismatch");
    expect(() => parseCalibrationStudy({ ...study(), pack: { ...BASELINE_DECISION_PACK_PIN, digest: `sha256:${"0".repeat(64)}` } })).toThrow();
  });

  it("rejects family leakage, duplicate cases/bands and unsupported model/context", () => {
    const crossing = study(2); crossing.cases[1]!.familyId = crossing.cases[0]!.familyId; crossing.cases[1]!.split = "calibration";
    expect(() => parseCalibrationStudy(crossing)).toThrow("crosses data splits");
    const duplicate = study(); duplicate.cases.push(duplicate.cases[0]!);
    expect(() => parseCalibrationStudy(duplicate)).toThrow();
    const bands = study(); bands.bands.push(bands.bands[0]!);
    expect(() => parseCalibrationStudy(bands)).toThrow();
    const model = study(); model.bands[0]!.modelId = "unsupported";
    expect(() => parseCalibrationStudy(model)).toThrow();
    const unknown = study(); (unknown.cases[0]!.cohort as Record<string, unknown>).gradeBand = "unknown";
    expect(() => parseCalibrationStudy(unknown)).toThrow();
    expect(() => parseCalibrationStudy({ ...study(), authorExpected: "positive" })).toThrow();
  });

  it("blinds ids/order and excludes family, split, origin, bands, labels and predictions", () => {
    const s = study(2); let n = 2;
    const { packet, key } = prepareCalibrationPacket(s, () => `blind_${n--}`);
    expect(packet.items.map((i) => i.blindId)).toEqual(["blind_1", "blind_2"]);
    expect(key.blind_2).toBe("source_0");
    const serialized = JSON.stringify(packet);
    for (const secret of ["source_0", "family_0", '"split"', '"origin"', '"bands"', '"label"', '"score"']) expect(serialized).not.toContain(secret);
    expect(packet.items[0]!.decisions[0]!.instructions).toBe(s.decisions[0]!.textInstructions);
    expect(Object.isFrozen(packet.items[0]!.decisions)).toBe(true);
    expect(() => prepareCalibrationPacket(s, () => "repeat")).toThrow("blinding assignment");
    expect(() => prepareCalibrationPacket(s, () => "source_0")).toThrow("blinding assignment");
  });

  it("pins split, band, content and cohort before observations and detects key reassignment", () => {
    const s = study(2), input = observations(s);
    const reordered = Object.fromEntries(Object.entries(s).reverse());
    expect(calibrationStudyDigest(reordered)).toBe(input.studyDigest);
    for (const mutate of [
      (v: CalibrationStudy) => { v.cases[0]!.split = "development"; },
      (v: CalibrationStudy) => { v.bands[0]!.band.high = 0.9; },
      (v: CalibrationStudy) => { v.cases[0]!.cohort.language = "es"; },
      (v: CalibrationStudy) => { v.cases[0]!.content = { type: "text", text: "different" }; },
    ]) {
      const changed = study(2); mutate(changed);
      expect(() => scoreCalibration(changed, input)).toThrow("revision mismatch");
    }
    [input.key.blind_0, input.key.blind_1] = [input.key.blind_1!, input.key.blind_0!];
    expect(() => scoreCalibration(s, input)).toThrow("packet mismatch");
  });
});

describe("independent labels and held-out scoring", () => {
  it("requires two distinct reviewers and an independent adjudicator for disagreement", () => {
    const s = study(), i = observations(s);
    i.reviews[0]!.label = "positive";
    expect(metric(s, i)).toMatchObject({ disagreements: 1, unresolved: 1, adjudicated: 0 });
    i.adjudications.push({ adjudicatorRef: "reviewer_1", blindId: "blind_0", decisionId: "self_harm", label: "positive" });
    expect(() => scoreCalibration(s, i)).toThrow("not independent");
    i.adjudications[0]!.adjudicatorRef = "adjudicator_3";
    expect(metric(s, i)).toMatchObject({ disagreements: 1, unresolved: 0, adjudicated: 1, falseNegatives: 1 });
    i.reviews = i.reviews.filter((r) => r.decisionId !== "self_harm" || r.reviewerRef === "reviewer_1");
    expect(() => scoreCalibration(s, i)).toThrow("not independent");
    i.adjudications = [];
    expect(metric(s, i).unresolved).toBe(1);
  });

  it("rejects duplicate reviewers/predictions, unknown decisions, keys and nonfinite scores", () => {
    const s = study();
    const transforms: ((i: CalibrationInput) => void)[] = [
      (i) => { i.reviews.push(i.reviews[0]!); },
      (i) => { i.predictions.push(i.predictions[0]!); },
      (i) => { i.predictions[0]!.decisionId = "unknown"; },
      (i) => { i.reviews[0]!.blindId = "missing"; },
      (i) => { i.key.blind_0 = "unknown"; },
      (i) => { i.predictions[0]!.score = Number.NaN; },
      (i) => { i.predictions[0]!.score = 1.01; },
    ];
    for (const transform of transforms) { const i = observations(s); transform(i); expect(() => scoreCalibration(s, i)).toThrow(); }
  });

  it("excludes development and tuning cases, and keeps abstentions and unresolved labels in coverage", () => {
    const s = study(9); s.cases[7]!.split = "development"; s.cases[8]!.split = "calibration";
    const i = observations(s);
    const labels = ["positive", "positive", "positive", "negative", "negative", "negative", "ambiguous"] as const;
    const scores = [0.9, 0.1, 0.5, 0.9, 0.1, null, 0.9];
    for (const r of i.reviews) if (r.decisionId === "self_harm") r.label = labels[Number(r.blindId.slice(6))] ?? "positive";
    for (const p of i.predictions) if (p.decisionId === "self_harm") p.score = scores[Number(p.blindId.slice(6))] ?? null;
    const report = scoreCalibration(s, i), m = metric(s, i);
    expect(m).toMatchObject({ cases: 7, adjudicated: 6, unresolved: 1, truePositives: 1, falsePositives: 1, trueNegatives: 1, falseNegatives: 1,
      positiveAbstentions: 1, negativeAbstentions: 1, missingScores: 1,
      precision: { rate: 0.5 }, recall: { rate: 1 / 3 }, falsePositiveRate: { rate: 0.5 }, coverage: { rate: 4 / 7 }, labelCoverage: { rate: 6 / 7 } });
    expect(report).toMatchObject({ basis: "simulated", provenance: "operator-declared", activation: "not-approved", evaluationSplit: "held-out",
      splitCases: { development: 1, calibration: 1, "held-out": 7 }, modelId: CLEF_FLASH_MODEL });
    expect(JSON.stringify(report)).not.toContain("Fictional example");
    expect(JSON.stringify(report)).not.toContain("reviewer_1");
  });

  it("treats missing scores/bands as abstention, never reusing another model or language", () => {
    const s = study(), i = observations(s);
    s.bands[0]!.modelId = CLEF_MODEL;
    i.studyDigest = calibrationStudyDigest(s);
    i.packetDigest = prepareCalibrationPacket(s, () => "blind_0").packet.packetDigest;
    for (const r of i.reviews) if (r.decisionId === "self_harm") r.label = "positive";
    expect(metric(s, i)).toMatchObject({ positiveAbstentions: 1, missingBand: 1, recall: { rate: 0 }, coverage: { rate: 0 } });
    const other = study(); other.cases[0]!.cohort.language = "es";
    expect(metric(other, observations(other)).missingBand).toBe(1);
    const missing = observations(study()); missing.predictions = [];
    expect(metric(study(), missing)).toMatchObject({ negativeAbstentions: 1, missingScores: 1, coverage: { rate: 0 }, precision: { rate: null }, falsePositiveRate: { rate: null } });
  });

  it.each([[0.349, 1, 0, 0], [0.35, 0, 1, 0], [0.749, 0, 1, 0], [0.75, 0, 0, 1]])(
    "uses exact low/high boundaries at %s", (score, trueNegatives, negativeAbstentions, falsePositives) => {
      const s = study(), i = observations(s); i.predictions[0]!.score = score;
      expect(metric(s, i)).toMatchObject({ trueNegatives, negativeAbstentions, falsePositives });
    });

  it("never promotes an operator-declared measured import to approval", () => {
    const s = study(), i = observations(s); i.run.basis = "measured";
    expect(scoreCalibration(s, i)).toMatchObject({ basis: "measured", provenance: "operator-declared", kind: "calibration-candidate", activation: "not-approved" });
  });
});

describe("Wilson uncertainty", () => {
  it("reports unknown for empty denominators and meaningful limits for all-zero/all-one samples", () => {
    expect(calibrationInterval(0, 0)).toMatchObject({ rate: null, lower95: null, upper95: null });
    expect(calibrationInterval(0, 10).upper95).toBeCloseTo(0.27753, 4);
    expect(calibrationInterval(10, 10).lower95).toBeCloseTo(0.72247, 4);
    expect(calibrationInterval(5, 10).lower95).toBeCloseTo(0.23659, 4);
    for (const [n, total] of [[2, 1], [-1, 1], [0.5, 1], [0, Number.POSITIVE_INFINITY]]) expect(() => calibrationInterval(n!, total!)).toThrow();
  });
});
