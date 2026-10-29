import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { buildReceipt, CLEF_FLASH_MODEL, CLEF_MODEL, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { EDUCATOR_PROFILE, type PolicyProfile, STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import {
  buildClefInput,
  CLEF_IMAGE_QUESTIONS,
  CLEF_QUESTIONS,
  clefRequestFor,
  ClefTransportError,
  createClefClassifier,
  extractClefUsage,
  parseClefOutput,
} from "../src/index.ts";
import { FakeTransport, scored } from "./fake-transport.ts";

const TEXT = "Why does photosynthesis need light?";

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    schemaVersion: "1.0",
    requestId: "req_1",
    idempotencyKey: "idem_1",
    source: { product: "other", tenantId: "tenant_1", surface: "test" },
    policy: { profileId: "student-9-12", revision: "builtin-1" },
    context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_1" },
    evaluationKind: "interaction.input",
    content: { type: "text", text: TEXT },
    ...overrides,
  };
}

function classify(
  transport: FakeTransport,
  profile: PolicyProfile = STUDENT_9_12_PROFILE,
  options: { timeoutMs?: number; imageTimeoutMs?: number; req?: EvaluationRequest } = {},
) {
  let next = 0;
  const classifier = createClefClassifier({
    transport,
    priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
    newAttemptId: () => `att_${next++}`,
    clock: () => new Date("2026-10-20T12:00:00Z"),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.imageTimeoutMs === undefined ? {} : { imageTimeoutMs: options.imageTimeoutMs }),
  });
  return classifier.evaluate(options.req ?? request(), { profile, signal: new AbortController().signal });
}

describe("createClefClassifier", () => {
  it("denies a primary route before transport without recording a provider attempt", async () => {
    const transport = new FakeTransport([]);
    const plugin = createClefClassifier({ transport, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      newAttemptId: () => "att_denied", authorizeModel: () => false });
    const result = await plugin.evaluate(request(), { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal });
    expect(transport.calls).toHaveLength(0); expect(result.attempts).toHaveLength(0);
    expect(result.signals).toEqual({ classifierUnavailable: true });
  });

  it("rechecks authority after primary completion and does not meter denied escalation", async () => {
    let current = true;
    const transport = new FakeTransport([scored({ violence: 0.5 })]);
    const guarded = { async run(...args: Parameters<FakeTransport["run"]>) {
      const result = await transport.run(...args); current = false; return result;
    } };
    const checked: string[] = [];
    const plugin = createClefClassifier({ transport: guarded, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      newAttemptId: () => "att_one", authorizeModel: (model) => { checked.push(model); return current; } });
    const result = await plugin.evaluate(request(), { profile: STUDENT_9_12_PROFILE, signal: new AbortController().signal });
    expect(checked).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL]); expect(transport.calls).toHaveLength(1);
    expect(result.attempts).toHaveLength(1); expect(result.signals).toEqual({ uncertain: true });
  });

  it("makes one Clef-flash call for a clear result and prices it exactly", async () => {
    const transport = new FakeTransport([scored()]);
    const output = await classify(transport);
    expect(transport.calls.map((call) => call.model)).toEqual([CLEF_FLASH_MODEL]);
    expect(output.findings).toEqual([]);
    expect(output.signals).toEqual({});
    expect(output.attempts).toEqual([
      {
        attemptId: "att_0",
        attemptIndex: 0,
        providerId: "cloudflare-workers-ai",
        modelId: CLEF_FLASH_MODEL,
        sku: CLEF_FLASH_MODEL,
        priceBookId: "cloudflare-2026-10-20",
        units: { inputTokens: 602 },
        grossUsdNano: "22876",
        state: "provider_reported",
        gatewayLogId: "log_fake",
      },
    ]);
  });

  it("turns confident scores into findings with policy-neutral severities", async () => {
    const output = await classify(new FakeTransport([scored({ self_harm: 0.91, dangerous_instructions: 0.88 })]));
    expect(output.findings.map((f) => [f.reasonCode, f.category, f.severity, f.confidence])).toEqual([
      ["clef.self_harm", "self-harm", "support", 0.91],
      ["clef.dangerous_instructions", "safety", "block", 0.88],
    ]);
  });

  it("escalates an ambiguous result exactly once and records both attempts", async () => {
    const transport = new FakeTransport([scored({ violence: 0.5 }), scored({ violence: 0.6 }, 0.02, 1500)]);
    const output = await classify(transport);
    expect(transport.calls.map((call) => call.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL]);
    expect(output.attempts.map((a) => [a.attemptIndex, a.modelId, a.grossUsdNano])).toEqual([
      [0, CLEF_FLASH_MODEL, "22876"],
      [1, CLEF_MODEL, "360000"],
    ]);
    // Still ambiguous after escalation: uncertain, no second escalation, no finding.
    expect(output.signals).toEqual({ uncertain: true });
    expect(output.findings).toEqual([]);
    const receipt = buildReceipt({
      receiptId: "rcpt_1",
      tenantId: "tenant_1",
      product: "other",
      costCenterId: "cc_1",
      logicalRequestId: "req_1",
      createdAt: "2026-10-20T12:00:00.000Z",
      purpose: "moderation.input",
      attempts: [...output.attempts],
    });
    expect(receipt).toMatchObject({ totalGrossUsdNano: "382876", hasUnknownCost: false });
  });

  it("uses the escalation's answer when it is confident", async () => {
    const output = await classify(new FakeTransport([scored({ hate: 0.5 }), scored({ hate: 0.95 }, 0.02, 1500)]));
    expect(output.findings.map((f) => f.reasonCode)).toEqual(["clef.hate"]);
    expect(output.signals).toEqual({});
  });

  it("does not escalate when the profile disables escalation or the kind is not allowed", async () => {
    const noEscalation = { ...STUDENT_9_12_PROFILE, escalation: { enabled: false, maxShare: 0 } };
    const first = new FakeTransport([scored({ violence: 0.5 })]);
    expect((await classify(first, noEscalation)).signals).toEqual({ uncertain: true });
    expect(first.calls).toHaveLength(1);

    const second = new FakeTransport([scored({ violence: 0.5 })]);
    await classify(second, STUDENT_9_12_PROFILE, { req: request({ evaluationKind: "interaction.output" }) });
    expect(second.calls).toHaveLength(1);
  });

  it("keeps the primary answer, uncertain, when the escalation fails", async () => {
    const output = await classify(new FakeTransport([scored({ violence: 0.5 }), new ClefTransportError("unavailable", 503)]));
    expect(output.signals).toEqual({ uncertain: true });
    expect(output.attempts.map((a) => a.state)).toEqual(["provider_reported", "unknown"]);
  });

  it("reports a 429 as unavailable, with an unknown-cost attempt and no findings", async () => {
    const output = await classify(new FakeTransport([new ClefTransportError("rate_limited", 429)]));
    expect(output.findings).toEqual([]);
    expect(output.signals).toEqual({ classifierUnavailable: true });
    expect(output.attempts).toHaveLength(1);
    expect(output.attempts[0]).toMatchObject({ state: "unknown", units: {} });
    expect(output.attempts[0]).not.toHaveProperty("grossUsdNano");
  });

  it("times out, aborting the call", async () => {
    const output = await classify(new FakeTransport(["hang"]), STUDENT_9_12_PROFILE, { timeoutMs: 5 });
    expect(output.signals).toEqual({ classifierUnavailable: true, classifierTimedOut: true });
    expect(output.attempts[0]?.state).toBe("unknown");
  });

  it("treats malformed output as uncertain, still metering the attempt", async () => {
    const output = await classify(new FakeTransport([{ output: { verdict: "probably fine" }, usage: { inputTokens: 1000 } }]));
    expect(output.findings).toEqual([]);
    expect(output.signals).toEqual({ uncertain: true });
    expect(output.attempts[0]).toMatchObject({ state: "provider_reported", grossUsdNano: "38000" });
  });

  it("records missing usage as unknown cost instead of guessing tokens from text", async () => {
    const output = await classify(new FakeTransport([scored({}, 0.02, null)]));
    expect(output.attempts[0]).toMatchObject({ state: "unknown", units: {} });
    expect(output.attempts[0]).not.toHaveProperty("grossUsdNano");
  });

  it("holds rather than blocks for non-student audiences", async () => {
    const output = await classify(new FakeTransport([scored({ prompt_injection: 0.9, sexual: 0.9 })]), EDUCATOR_PROFILE, {
      req: request({ context: { audience: "educator", costCenterId: "cc_1" } }),
    });
    expect(output.findings.map((f) => f.severity)).toEqual(["hold", "hold"]);
  });

  it("makes no call for digest-only content", async () => {
    const transport = new FakeTransport([]);
    const output = await classify(transport, STUDENT_9_12_PROFILE, {
      req: request({ content: { type: "digest", digest: "a".repeat(64), mimeType: "image/png" } }),
    });
    expect(output).toEqual({ findings: [], attempts: [] });
  });

  it("rejects inverted thresholds", () => {
    expect(() =>
      createClefClassifier({ transport: new FakeTransport([]), priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, newAttemptId: () => "a", thresholds: { low: 0.8, high: 0.2 } }),
    ).toThrow(RangeError);
  });
});

describe("clef protocol", () => {
  it("requires every question to be answered", () => {
    expect(parseClefOutput({ answers: { self_harm: { type: "noul", noul: 0.1 } } })).toBeNull();
    expect(parseClefOutput({ answers: { self_harm: { type: "noul", noul: 2 } } })).toBeNull();
    expect(parseClefOutput("not json")).toBeNull();
  });

  it("reads usage in either token field name, and never invents it", () => {
    expect(extractClefUsage({ usage: { input_tokens: 12, output_tokens: 0 } })).toEqual({ inputTokens: 12 });
    expect(extractClefUsage({ usage: { input_tokens: 7, neurons: 3 } })).toEqual({ inputTokens: 7, neurons: 3 });
    expect(extractClefUsage({ answers: {} })).toBeUndefined();
  });
});

describe("Clef request shape", () => {
  it("sends the published Clef input: model selector, state and noul questions keyed by id", async () => {
    const transport = new FakeTransport([scored()]);
    await classify(transport);
    expect(transport.calls[0]?.input).toMatchObject({
      model: "clef-flash",
      state: { text: TEXT, audience: "student", gradeBand: "9-12", evaluationKind: "interaction.input" },
      questions: { self_harm: { type: "noul", instructions: expect.any(String) } },
    });
  });

  it("rejects a non-Clef model selector", () => {
    expect(() => clefRequestFor("@cf/cloudflare/clef-omni", buildClefInput(request(), TEXT))).toThrow(RangeError);
  });
});

/** A synthetic 1x1 PNG. Its bytes must never appear in findings or attempts. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

function imageRequest(text?: string): EvaluationRequest {
  return request({
    evaluationKind: "content.candidate",
    content: { type: "image", images: [{ mimeType: "image/png", base64: PNG }, { mimeType: "image/png", base64: PNG }], ...(text === undefined ? {} : { text }) },
  });
}

describe("image content", () => {
  it("sends the images in Clef's base64 form with the image questions to Clef-flash", async () => {
    const transport = new FakeTransport([scored({}, 0.02, 1093)]);
    const output = await classify(transport, STUDENT_9_12_PROFILE, { req: imageRequest("A labelled diagram") });
    expect(transport.calls.map((call) => call.model)).toEqual([CLEF_FLASH_MODEL]);
    const input = transport.calls[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({
      model: "clef-flash",
      images: [
        { content_type: "image/png", base64: PNG },
        { content_type: "image/png", base64: PNG },
      ],
      state: { text: "A labelled diagram", audience: "student", evaluationKind: "content.candidate" },
    });
    expect(input.questions).toEqual(Object.fromEntries(CLEF_IMAGE_QUESTIONS.map(({ id, instructions }) => [id, { type: "noul", instructions }])));
    expect(output.findings).toEqual([]);
    // Image tokens arrive inside the reported input tokens: 1,093 at $0.038 per million.
    expect(output.attempts).toMatchObject([{ units: { inputTokens: 1093 }, grossUsdNano: "41534", state: "provider_reported" }]);
    expect(JSON.stringify(output)).not.toContain(PNG);
  });

  it("sends images without text as a state with labels only", async () => {
    const transport = new FakeTransport([scored()]);
    await classify(transport, STUDENT_9_12_PROFILE, { req: imageRequest() });
    const state = (transport.calls[0]!.input as { state: Record<string, unknown> }).state;
    expect(state).toEqual({ audience: "student", evaluationKind: "content.candidate", gradeBand: "9-12" });
  });

  it("turns confident image scores into findings with the text severities", async () => {
    const output = await classify(new FakeTransport([scored({ sexual: 0.93, self_harm: 0.9 })]), STUDENT_9_12_PROFILE, { req: imageRequest() });
    expect(output.findings.map((f) => [f.reasonCode, f.severity])).toEqual([
      ["clef.self_harm", "support"],
      ["clef.sexual", "block"],
    ]);
  });

  it("escalates an ambiguous image to Clef with the same images", async () => {
    const transport = new FakeTransport([scored({ violence: 0.5 }, 0.02, 1093), scored({ violence: 0.9 }, 0.02, 1500)]);
    const output = await classify(transport, STUDENT_9_12_PROFILE, { req: imageRequest() });
    expect(transport.calls.map((call) => call.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL]);
    expect((transport.calls[1]!.input as { model: string; images: unknown[] }).model).toBe("clef");
    expect((transport.calls[1]!.input as { images: unknown[] }).images).toHaveLength(2);
    expect(output.findings.map((f) => f.reasonCode)).toEqual(["clef.violence"]);
    expect(output.attempts.map((a) => a.grossUsdNano)).toEqual(["41534", "360000"]);
  });

  it("records unknown cost, never an estimate from image size, when usage is missing", async () => {
    const output = await classify(new FakeTransport([scored({}, 0.02, null)]), STUDENT_9_12_PROFILE, { req: imageRequest() });
    expect(output.attempts).toMatchObject([{ units: {}, state: "unknown" }]);
    expect(output.attempts[0]).not.toHaveProperty("grossUsdNano");
  });

  it("uses the longer image timeout for images and reports a timeout as unavailability", async () => {
    const slowText = await classify(new FakeTransport([scored()]), STUDENT_9_12_PROFILE, { timeoutMs: 1, imageTimeoutMs: 1000 });
    expect(slowText.signals).toEqual({});
    const output = await classify(new FakeTransport(["hang"]), STUDENT_9_12_PROFILE, { timeoutMs: 1000, imageTimeoutMs: 5, req: imageRequest() });
    expect(output.signals).toEqual({ classifierUnavailable: true, classifierTimedOut: true });
    expect(output.attempts).toMatchObject([{ state: "unknown" }]);
  });

  it("asks the image questions under the same ids and categories as the text questions", () => {
    expect(CLEF_IMAGE_QUESTIONS.map(({ id, category }) => [id, category])).toEqual(CLEF_QUESTIONS.map(({ id, category }) => [id, category]));
  });
});
