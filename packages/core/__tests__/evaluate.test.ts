import { createClefClassifier, CLEF_QUESTIONS, type ClefTransport, ClefTransportError, type ClefTransportResult } from "@gmacko/hall-monitor-clef";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { defaultBundle } from "@gmacko/hall-monitor-evaluators";
import { BUILTIN_PROFILES } from "@gmacko/hall-monitor-policy";
import { CORPUS, fixtureRequest } from "@gmacko/hall-monitor-test-fixtures";
import { describe, expect, it } from "vitest";
import { type EvaluateDeps, evaluate, HallMonitorError } from "../src/index.ts";

type Reply = ClefTransportResult | Error | "hang";

class ScriptedTransport implements ClefTransport {
  readonly models: string[] = [];
  constructor(private readonly replies: Reply[]) {}
  async run(model: string, _input: unknown, { signal }: { signal: AbortSignal }): Promise<ClefTransportResult> {
    this.models.push(model);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("unexpected call");
    if (reply === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

function answer(overrides: Record<string, number> = {}, inputTokens = 602): ClefTransportResult {
  return {
    output: { answers: CLEF_QUESTIONS.map((question) => ({ id: question.id, score: overrides[question.id] ?? 0.01 })) },
    usage: { inputTokens },
  };
}

function deps(transport: ClefTransport | null, overrides: Partial<EvaluateDeps> = {}): EvaluateDeps {
  let n = 0;
  const clock = () => new Date("2026-10-20T12:00:00.000Z");
  return {
    policies: (id, revision) => (revision === "builtin-1" ? BUILTIN_PROFILES[id] : undefined),
    bundle: defaultBundle,
    ...(transport === null
      ? {}
      : {
          classifier: createClefClassifier({
            transport,
            priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
            newAttemptId: () => `att_${n++}`,
            clock,
            timeoutMs: 5,
          }),
        }),
    priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
    clock,
    ids: { evaluationId: () => "eval_1", receiptId: () => "rcpt_1" },
    ...overrides,
  };
}

function fixture(id: string): EvaluationRequest {
  const found = CORPUS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return fixtureRequest(found);
}

describe("evaluate", () => {
  it("allows a benign question after one Clef-flash check, with an exact receipt", async () => {
    const transport = new ScriptedTransport([answer()]);
    const request = fixture("benign-02");
    const result = await evaluate(request, deps(transport));
    expect(result).toMatchObject({
      schemaVersion: "1.0",
      evaluationId: "eval_1",
      requestId: request.requestId,
      decision: "allow",
      reasonCodes: [],
      uncertain: false,
      policyRevision: "builtin-1",
      evaluatorBundleRevision: "base-1.0.0:clef-1.0.0",
      resolverVersion: "resolver-1.0.0",
    });
    expect(result.receipt).toEqual({
      receiptId: "rcpt_1",
      tenantId: "tenant_fixture",
      product: "other",
      costCenterId: "cc_fixture",
      logicalRequestId: request.requestId,
      createdAt: "2026-10-20T12:00:00.000Z",
      purpose: "moderation.input",
      attempts: [expect.objectContaining({ modelId: CLEF_FLASH_MODEL, grossUsdNano: "22876", state: "provider_reported" })],
      totalGrossUsdNano: "22876",
      hasUnknownCost: false,
    });
  });

  it("never echoes content into the result", async () => {
    for (const id of ["benign-02", "pii-01", "injection-06", "distress-01", "harmful-03"]) {
      const request = fixture(id);
      const result = await evaluate(request, deps(new ScriptedTransport([answer()])));
      const serialized = JSON.stringify(result);
      if (request.content.type === "text") {
        for (const word of request.content.text.split(/\s+/).filter((w) => w.length >= 6)) {
          expect(serialized, id).not.toContain(word);
        }
      }
    }
  });

  it("skips the classifier when deterministic findings are decisive", async () => {
    for (const [id, decision] of [
      ["harmful-01", "block"],
      ["distress-01", "support"],
      ["injection-01", "block"],
    ] as const) {
      const transport = new ScriptedTransport([]);
      const result = await evaluate(fixture(id), deps(transport));
      expect(result.decision, id).toBe(decision);
      expect(transport.models).toEqual([]);
      expect(result.receipt).toBeNull();
    }
  });

  it("coaches a graded direct-answer request", async () => {
    const result = await evaluate(fixture("integrity-01"), deps(new ScriptedTransport([answer()])));
    expect(result.decision).toBe("coach");
    expect(result.reasonCodes).toEqual(["academic_integrity.direct_answer_request"]);
  });

  it("routes a classifier-detected disclosure to support", async () => {
    const result = await evaluate(fixture("distress-13"), deps(new ScriptedTransport([answer({ self_harm: 0.93 })])));
    expect(result.decision).toBe("support");
    expect(result.findings.map((finding) => finding.reasonCode)).toEqual(["clef.self_harm"]);
  });

  it("escalates once and receipts both attempts exactly", async () => {
    const transport = new ScriptedTransport([answer({ harassment: 0.5 }), answer({ harassment: 0.9 }, 1500)]);
    const result = await evaluate(fixture("harassment-05"), deps(transport));
    expect(transport.models).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL]);
    expect(result.decision).toBe("hold");
    expect(result.receipt?.attempts.map((attempt) => attempt.grossUsdNano)).toEqual(["22876", "360000"]);
    expect(result.receipt?.totalGrossUsdNano).toBe("382876");
  });

  it("holds a student request when Clef is rate limited, recording the unknown cost", async () => {
    const result = await evaluate(fixture("benign-02"), deps(new ScriptedTransport([new ClefTransportError("rate_limited", 429)])));
    expect(result).toMatchObject({
      decision: "hold",
      reasonCodes: ["hall_monitor.unavailable"],
      uncertain: true,
      degraded: { reason: "classifier_unavailable" },
    });
    expect(result.receipt).toMatchObject({ totalGrossUsdNano: "0", hasUnknownCost: true });
  });

  it("decides educator requests from deterministic checks when Clef times out", async () => {
    const result = await evaluate(fixture("benign-09"), deps(new ScriptedTransport(["hang"])));
    expect(result).toMatchObject({
      decision: "allow",
      reasonCodes: ["hall_monitor.deterministic_only"],
      degraded: { reason: "classifier_timeout" },
    });
  });

  it("treats a missing classifier as unavailable for required moderation", async () => {
    const result = await evaluate(fixture("benign-02"), deps(null));
    expect(result).toMatchObject({ decision: "hold", receipt: null, evaluatorBundleRevision: "base-1.0.0" });
  });

  it("does not fail closed for optional moderation", async () => {
    const output: EvaluationRequest = { ...fixture("benign-09"), evaluationKind: "interaction.output" };
    const result = await evaluate(output, deps(new ScriptedTransport([new ClefTransportError("unavailable", 503)])));
    expect(result.decision).toBe("allow");
    expect(result.degraded).toBeUndefined();
    expect(result.receipt?.purpose).toBe("moderation.output");
  });

  it("blocks generative work when the safety budget refuses classification", async () => {
    const transport = new ScriptedTransport([]);
    const result = await evaluate(fixture("benign-02"), deps(transport, { admitClassification: () => false }));
    expect(result).toMatchObject({ decision: "block", reasonCodes: ["hall_monitor.budget_exhausted"], degraded: { reason: "budget_exhausted" } });
    expect(transport.models).toEqual([]);
  });

  it("skips classification when the profile turns the stage off", async () => {
    const transport = new ScriptedTransport([]);
    const request: EvaluationRequest = { ...fixture("content-01"), evaluationKind: "interaction.output" };
    const result = await evaluate(request, deps(transport));
    expect(result.decision).toBe("allow");
    expect(transport.models).toEqual([]);
  });

  it("rejects unsupported versions, invalid requests and unknown policies without quoting content", async () => {
    const valid = fixture("pii-01");
    const errorOf = (input: unknown, d = deps(null)) => evaluate(input, d).then(() => null, (error: unknown) => error);

    expect(((await errorOf({ ...valid, schemaVersion: "2.0" })) as HallMonitorError).body).toEqual({
      code: "unsupported_schema",
      message: "schemaVersion is not supported",
      retryable: false,
    });
    const invalid = (await errorOf({ ...valid, context: { ...valid.context, audience: "sam.sample@example.com" } })) as HallMonitorError;
    expect(invalid.body.code).toBe("invalid_request");
    expect(invalid.body.message).toBe("invalid fields: context.audience");
    expect(((await errorOf(null)) as HallMonitorError).body.code).toBe("invalid_request");
    const missing = (await errorOf({ ...valid, policy: { profileId: "student-9-12", revision: "nope" } })) as HallMonitorError;
    expect(missing.body.code).toBe("policy_not_found");
  });
});
