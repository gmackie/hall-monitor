import type { ClefTransport, ClefTransportResult } from "@gmacko/hall-monitor-clef";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CLAIRIC_FLASH_MODEL, CLAIRIC_MODEL, CURRENT_PRICE_BOOK } from "@gmacko/hall-monitor-costing";
import { STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import { buildClairicInput, CLAIRIC_FIELDS, createClairicEvaluator, fieldsFor, parseClairicOutput } from "../src/index.ts";

const TEXT = "Hi, I'm Sam Example, text me on 555-0100.";

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    schemaVersion: "1.0", requestId: "req_c", idempotencyKey: "idem_c",
    source: { product: "playtrek", tenantId: "t", surface: "student.chat" },
    policy: { profileId: "student-9-12", revision: "builtin-1" },
    context: { audience: "student", gradeBand: "9-12", costCenterId: "cc" },
    evaluationKind: "interaction.input", content: { type: "text", text: TEXT },
    ...overrides,
  };
}

function scripted(replies: (ClefTransportResult | Error)[]) {
  const calls: { model: string; input: unknown }[] = [];
  const transport: ClefTransport = {
    async run(model, input) {
      calls.push({ model, input });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected call");
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { transport, calls };
}

const identifiers = (confidence: number): ClefTransportResult => ({
  output: { answers: { personal_identifiers: { value: [{ text: "x", span: { start: 8, end: 19 } }, { text: "y", span: [32, 40] }], confidence } } },
  usage: { inputTokens: 1200 },
});

let n = 0;
const evaluator = (transport: ClefTransport, authorizeModel?: (model: string) => boolean) =>
  createClairicEvaluator({ transport, priceBook: CURRENT_PRICE_BOOK, newAttemptId: () => `att_${n++}`, clock: () => new Date("2026-11-22T00:00:00Z"), ...(authorizeModel ? { authorizeModel } : {}) });
const context = { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal };

describe("Clairic protocol", () => {
  it("asks only the fields that apply, keeping the answer key out of state", () => {
    expect(fieldsFor(request()).map((field) => field.id)).toEqual(["personal_identifiers"]);
    const output = request({ evaluationKind: "interaction.output", content: { type: "text", text: TEXT, answerKey: ["42"] } });
    expect(fieldsFor(output).map((field) => field.id)).toEqual(["personal_identifiers", "stated_answers", "reveals_answer"]);
    const input = buildClairicInput(CLAIRIC_FLASH_MODEL, output, fieldsFor(output));
    expect(input.model).toBe("clairic-flash");
    expect(input.state).toBe(TEXT);
    expect(input.fields.reveals_answer!.instructions).toContain("\"42\"");
    expect(fieldsFor(request({ evaluationKind: "assessment.evaluator-result" })).map((field) => field.id)).toEqual(["personal_identifiers", "stated_score", "states_pass", "score_matches_verdict"]);
    expect(() => buildClairicInput("@cf/cloudflare/clef", request(), CLAIRIC_FIELDS)).toThrow(RangeError);
  });

  it("parses keyed and listed answers, drops out-of-range spans and refuses missing fields", () => {
    const fields = fieldsFor(request());
    const keyed = parseClairicOutput({ answers: { personal_identifiers: { value: [], confidence: 0.9, spans: [[0, 3], [5, 999]] } } }, fields, TEXT.length);
    expect(keyed?.get("personal_identifiers")?.spans).toEqual([{ start: 0, end: 3 }]);
    const listed = parseClairicOutput({ answers: [{ field: "personal_identifiers", value: [], confidence: 0.2 }] }, fields, TEXT.length);
    expect(listed?.get("personal_identifiers")?.confidence).toBe(0.2);
    expect(parseClairicOutput({ answers: {} }, fields, TEXT.length)).toBeNull();
    expect(parseClairicOutput("nope", fields, TEXT.length)).toBeNull();
  });
});

describe("createClairicEvaluator", () => {
  it("turns confident identifiers into a located, content-free privacy finding", async () => {
    const { transport, calls } = scripted([identifiers(0.92)]);
    const output = await evaluator(transport).evaluate(request(), context);
    expect(calls.map((call) => call.model)).toEqual([CLAIRIC_FLASH_MODEL]);
    expect(output.findings).toEqual([
      expect.objectContaining({
        category: "privacy", reasonCode: "clairic.personal_identifier", severity: "hold", span: { start: 8, end: 19 },
        evidence: [{ field: "personal_identifier", span: { start: 8, end: 19 }, confidence: 0.92 }, { field: "personal_identifier", span: { start: 32, end: 40 }, confidence: 0.92 }],
      }),
    ]);
    expect(JSON.stringify(output.findings)).not.toContain("Sam");
    expect(output.attempts[0]).toMatchObject({ modelId: CLAIRIC_FLASH_MODEL, state: "provider_reported", grossUsdNano: "120000" });
    expect(output.trace).toMatchObject({ family: "clairic", escalated: false, calls: [{ modelId: CLAIRIC_FLASH_MODEL, role: "primary", outcome: "scored" }] });
  });

  it("escalates once on low confidence and reports why", async () => {
    const { transport, calls } = scripted([identifiers(0.5), identifiers(0.95)]);
    const output = await evaluator(transport).evaluate(request(), context);
    expect(calls.map((call) => call.model)).toEqual([CLAIRIC_FLASH_MODEL, CLAIRIC_MODEL]);
    expect(output.trace).toMatchObject({ escalated: true, escalationReason: "low_confidence" });
    expect(output.findings).toHaveLength(1);
    expect(output.attempts.map((attempt) => attempt.grossUsdNano)).toEqual(["120000", "120000"]);
  });

  it("flags an evaluator result whose score and verdict disagree", async () => {
    const { transport } = scripted([{ output: { answers: {
      personal_identifiers: { value: [], confidence: 0.9 },
      stated_score: { value: 95, confidence: 0.9, span: { start: 0, end: 2 } },
      states_pass: { value: false, confidence: 0.9, span: { start: 10, end: 14 } },
      score_matches_verdict: { value: false, confidence: 0.88 },
    } }, usage: { inputTokens: 1000 } }]);
    const output = await evaluator(transport).evaluate(request({ evaluationKind: "assessment.evaluator-result" }), context);
    expect(output.findings.map((finding) => [finding.reasonCode, finding.severity, finding.category])).toEqual([["clairic.evaluator_inconsistent", "hold", "quality"]]);
  });

  it("reports provider failures and governance denials without findings", async () => {
    const failed = await evaluator(scripted([new Error("down")]).transport).evaluate(request(), context);
    expect(failed).toMatchObject({ findings: [], signals: { classifierUnavailable: true } });
    expect(failed.attempts[0]).toMatchObject({ state: "unknown" });
    const denied = await evaluator(scripted([]).transport, () => false).evaluate(request(), context);
    expect(denied.attempts).toEqual([]);
    expect(denied.trace?.calls).toEqual([{ modelId: CLAIRIC_FLASH_MODEL, role: "primary", outcome: "denied" }]);
  });

  it("declines non-text content", () => {
    const plugin = evaluator(scripted([]).transport);
    expect(plugin.supportsContent?.(request({ content: { type: "digest", digest: "a".repeat(64), mimeType: "text/plain" } }))).toBe(false);
    expect(plugin.family).toBe("clairic");
  });
});
