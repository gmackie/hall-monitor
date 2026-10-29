import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import { CLEF_IMAGE_QUESTIONS, CLEF_QUESTIONS, ClefTransportError, createClefClassifier, parseClefCalibration,
  type ClefCalibrationSelection, type ClefClassifierOptions } from "../src/index.ts";
import { FakeTransport, scored } from "./fake-transport.ts";

function request(): EvaluationRequest {
  return { schemaVersion: "1.0", requestId: "request_1", idempotencyKey: "idem_1", source: { product: "other", tenantId: "tenant_1", surface: "test" },
    policy: { profileId: STUDENT_9_12_PROFILE.id, revision: STUDENT_9_12_PROFILE.revision },
    context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_1" }, evaluationKind: "interaction.input", content: { type: "text", text: "Synthetic test." } };
}
function selection(): ClefCalibrationSelection {
  const cohort = { profileId: STUDENT_9_12_PROFILE.id, profileRevision: STUDENT_9_12_PROFILE.revision, gradeBand: "9-12" as const,
    audience: "student" as const, language: "en", modality: "text" as const, evaluationKind: "interaction.input" as const };
  return { schemaVersion: "1.0", revision: "test-calibration-1", language: "en", rows: [CLEF_FLASH_MODEL, CLEF_MODEL].map((modelId) => ({
    providerId: CLOUDFLARE_WORKERS_AI, modelId, cohort: { ...cohort }, questions: CLEF_QUESTIONS.map((q) => ({
      id: q.id, instructions: q.instructions, band: { low: 0.3, high: modelId === CLEF_MODEL ? 0.85 : 0.7 } })) })) };
}
async function classify(calibration: unknown, transport: FakeTransport, req = request(), rest: Partial<ClefClassifierOptions> = {}) {
  let next = 0;
  const plugin = createClefClassifier({ transport, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, newAttemptId: () => `attempt_${next++}`,
    calibration, ...rest });
  return plugin.evaluate(req, { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal });
}

describe("explicit per-question calibration", () => {
  it("selects distinct bands for each question and stamps the selected revision", async () => {
    const s = selection(); s.rows[0]!.questions[0]!.band = { low: 0.1, high: 0.2 };
    const transport = new FakeTransport([scored({ self_harm: 0.25, hate: 0.75 })]);
    const output = await classify(s, transport);
    expect(output.findings.map((f) => f.reasonCode)).toEqual(["clef.self_harm", "clef.hate"]);
    expect(output.findings.every((f) => f.evaluatorVersion === "1.1.0.cal.test-calibration-1")).toBe(true);
    expect(output.signals).toEqual({}); expect(transport.calls).toHaveLength(1);
  });

  it("interprets successful escalation scores using that model's bands", async () => {
    const transport = new FakeTransport([scored({ violence: 0.4 }), scored({ violence: 0.8 })]);
    const output = await classify(selection(), transport);
    expect(transport.calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL]);
    expect(output.findings).toEqual([]); // 0.8 is not a finding at the escalation model's 0.85 threshold.
    expect(output.signals).toEqual({ uncertain: true }); expect(output.attempts).toHaveLength(2);
  });

  it("keeps primary bands and uncertainty when escalation is missing, denied or fails", async () => {
    for (const reason of ["missing", "denied", "failed"] as const) {
      const s = selection(); if (reason === "missing") s.rows.pop();
      const transport = new FakeTransport([scored({ self_harm: 0.75, violence: 0.4 }), new ClefTransportError("unavailable")]);
      const output = await classify(s, transport, request(), reason === "denied" ? { authorizeModel: (model) => model === CLEF_FLASH_MODEL } : {});
      expect(output.findings.map((f) => f.reasonCode)).toEqual(["clef.self_harm"]);
      expect(output.signals).toEqual({ uncertain: true });
      expect(transport.calls).toHaveLength(reason === "failed" ? 2 : 1);
      expect(output.attempts).toHaveLength(reason === "failed" ? 2 : 1);
    }
  });

  it.each(["profileId", "profileRevision", "gradeBand", "language", "modality", "evaluationKind", "audience"] as const)(
    "makes no call for an unmatched %s", async (field) => {
      const s = selection();
      for (const row of s.rows) Object.assign(row.cohort, { [field]: field === "modality" ? "image" : field === "gradeBand" ? "6-8" :
        field === "evaluationKind" ? "interaction.output" : field === "audience" ? "educator" : "other" });
      const transport = new FakeTransport([]);
      expect(await classify(s, transport)).toMatchObject({ findings: [], attempts: [], signals: { classifierUnavailable: true, uncertain: true } });
      expect(transport.calls).toEqual([]);
    });

  it("declines missing language/grade, unknown keys, duplicate rows, invalid/missing bands and changed instructions", async () => {
    const variants: unknown[] = [null, {}, { ...selection(), language: null }, { ...selection(), basis: "simulated" }];
    const duplicate = selection(); duplicate.rows.push(duplicate.rows[0]!); variants.push(duplicate);
    const missing = selection(); missing.rows[0]!.questions.pop(); variants.push(missing);
    const changed = selection(); changed.rows[0]!.questions[0]!.instructions += "changed"; variants.push(changed);
    const invalid = selection(); invalid.rows[0]!.questions[0]!.band = { low: 0.8, high: 0.2 }; variants.push(invalid);
    for (const s of variants) {
      const transport = new FakeTransport([]);
      expect((await classify(s, transport)).signals?.classifierUnavailable).toBe(true);
      expect(transport.calls).toEqual([]);
    }
    const req = request(); delete req.context.gradeBand;
    const transport = new FakeTransport([]);
    expect((await classify(selection(), transport, req)).signals?.classifierUnavailable).toBe(true);
    expect(transport.calls).toEqual([]);
  });

  it("binds image-specific question bytes and snapshots selection at construction", async () => {
    const req = request(); req.content = { type: "image", images: [{ mimeType: "image/png", base64: "YQ==" }] };
    const s = selection();
    for (const row of s.rows) { row.cohort.modality = "image"; row.questions = CLEF_IMAGE_QUESTIONS.map((q) => ({ ...q, band: { low: 0.3, high: 0.7 } }));
      // The strict selection has only wire id/instructions/band, never arbitrary question properties.
      row.questions = row.questions.map(({ id, instructions, band }) => ({ id, instructions, band })); }
    const transport = new FakeTransport([scored({ sexual: 0.8 })]);
    const plugin = createClefClassifier({ transport, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, newAttemptId: () => "attempt_1", calibration: s });
    s.rows[0]!.questions[2]!.band.high = 0.99;
    const output = await plugin.evaluate(req, { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal });
    expect(output.findings.map((f) => f.reasonCode)).toEqual(["clef.sexual"]);
    expect(Object.isFrozen(parseClefCalibration(selection())!.rows[0]!.questions[0]!.band)).toBe(true);
  });

  it("rejects combining explicit calibration with legacy global thresholds", () => {
    expect(() => createClefClassifier({ transport: new FakeTransport([]), priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      newAttemptId: () => "attempt_1", calibration: selection(), thresholds: { low: 0.2, high: 0.9 } })).toThrow(RangeError);
  });

  it("cannot drop an explicit invalid selection into placeholder fallback by mutating options", async () => {
    const transport = new FakeTransport([]);
    const options: ClefClassifierOptions = { transport, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, newAttemptId: () => "attempt_1", calibration: null };
    const plugin = createClefClassifier(options);
    Object.assign(options, { calibration: undefined });
    expect((await plugin.evaluate(request(), { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal })).signals?.classifierUnavailable).toBe(true);
    expect(transport.calls).toEqual([]);
  });
});
