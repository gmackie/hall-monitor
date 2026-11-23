import { CLEF_QUESTIONS, createClefClassifier, type ClefTransport, type ClefTransportResult } from "@gmacko/hall-monitor-clef";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CURRENT_PRICE_BOOK } from "@gmacko/hall-monitor-costing";
import { defaultBundle, type EvaluatorPlugin } from "@gmacko/hall-monitor-evaluators";
import { applyOverlay, type PolicyProfile, STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import { bundleRevision, type EvaluateDeps, evaluate } from "../src/index.ts";

const AT = new Date("2026-11-22T00:00:00Z");
const clefAnswer: ClefTransportResult = {
  output: { answers: Object.fromEntries(CLEF_QUESTIONS.map((question) => [question.id, { type: "noul", noul: 0.01 }])) },
  usage: { inputTokens: 600 },
};
const clefTransport: ClefTransport = { run: async () => clefAnswer };

/** A stand-in second family that reports one privacy finding and one billed call. */
function fakeFamily(behaviour: "finding" | "throw" | "unavailable" = "finding"): EvaluatorPlugin {
  return {
    id: "clairic",
    family: "clairic",
    version: "0.1.0",
    supportedKinds: ["interaction.input", "interaction.output", "content.candidate", "assessment.evaluator-result"],
    supportsContent: (request) => request.content.type === "text",
    async evaluate() {
      if (behaviour === "throw") throw new Error("boom");
      const attempt = { attemptId: "att_x", attemptIndex: 0, providerId: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clairic-flash", sku: "@cf/cloudflare/clairic-flash", priceBookId: CURRENT_PRICE_BOOK.id, units: { inputTokens: 900 }, state: "provider_reported" as const };
      if (behaviour === "unavailable") return { findings: [], attempts: [attempt], signals: { classifierUnavailable: true } };
      return {
        findings: [{ evaluatorId: "clairic", evaluatorVersion: "0.1.0", category: "privacy" as const, reasonCode: "clairic.personal_identifier", severity: "hold" as const, confidence: 0.9, evidence: [{ field: "personal_identifier", span: { start: 0, end: 3 } }] }],
        attempts: [attempt],
        trace: { family: "clairic", calibrationRevision: null, calls: [{ modelId: "@cf/cloudflare/clairic-flash", role: "primary" as const, outcome: "scored" as const, attemptId: "att_x" }], escalated: false },
      };
    },
  };
}

let ids = 0;
function deps(profile: PolicyProfile, second: EvaluatorPlugin = fakeFamily()): EvaluateDeps {
  return {
    policies: () => profile,
    bundle: defaultBundle,
    classifier: createClefClassifier({ transport: clefTransport, priceBook: CURRENT_PRICE_BOOK, newAttemptId: () => `att_${ids++}`, clock: () => AT }),
    classifiers: [second],
    priceBook: CURRENT_PRICE_BOOK,
    clock: () => AT,
    ids: { evaluationId: () => `eval_${ids++}`, receiptId: () => `rcpt_${ids++}` },
  };
}

function request(content: EvaluationRequest["content"] = { type: "text", text: "Sam lives nearby" }): EvaluationRequest {
  return {
    schemaVersion: "1.0", requestId: "req_f", idempotencyKey: "idem_f",
    source: { product: "playtrek", tenantId: "t", surface: "student.chat" },
    policy: { profileId: "student-9-12", revision: "builtin-1" },
    context: { audience: "student", gradeBand: "9-12", costCenterId: "cc" },
    evaluationKind: "interaction.input", content,
  };
}

const routed = (mode: "shadow" | "enforce") =>
  applyOverlay(STUDENT_9_12_PROFILE, { revision: `t-${mode}`, routing: { clairic: { enabled: true, mode } } }).profile;

describe("model families", () => {
  it("keeps the pre-routing result when the profile does not enable the second family", async () => {
    const result = await evaluate(request(), deps(STUDENT_9_12_PROFILE));
    expect(result.decision).toBe("allow");
    expect(result.evaluatorBundleRevision).toBe("base-1.1.0:clef-1.1.0");
    expect(result.receipt?.attempts.map((attempt) => attempt.modelId)).toEqual(["@cf/cloudflare/clef-flash"]);
    expect(result.route?.classifiers.map((route) => [route.family, route.status, route.skipReason])).toEqual([
      ["clef", "ran", undefined],
      ["clairic", "skipped", "profile_disabled"],
    ]);
  });

  it("records a shadow family's findings on its route, bills it, and leaves the decision alone", async () => {
    const result = await evaluate(request(), deps(routed("shadow")));
    expect(result.decision).toBe("allow");
    expect(result.findings.some((finding) => finding.evaluatorId === "clairic")).toBe(false);
    const route = result.route!.classifiers.find((entry) => entry.family === "clairic")!;
    expect(route).toMatchObject({ status: "ran", mode: "shadow" });
    expect(route.shadowFindings?.map((finding) => finding.reasonCode)).toEqual(["clairic.personal_identifier"]);
    expect(result.receipt?.attempts.map((attempt) => attempt.modelId)).toEqual(["@cf/cloudflare/clef-flash", "@cf/cloudflare/clairic-flash"]);
    expect(result.evaluatorBundleRevision).toBe("base-1.1.0:clef-1.1.0:clairic-0.1.0");
  });

  it("lets an enforcing family decide", async () => {
    const result = await evaluate(request(), deps(routed("enforce")));
    expect(result.decision).toBe("hold");
    expect(result.reasonCodes).toContain("clairic.personal_identifier");
  });

  it("ignores a shadow family's failures but not an enforcing one's", async () => {
    const shadowFail = await evaluate(request(), deps(routed("shadow"), fakeFamily("throw")));
    expect(shadowFail).toMatchObject({ decision: "allow", uncertain: false });
    expect(shadowFail.degraded).toBeUndefined();
    const enforceDown = await evaluate(request(), deps(routed("enforce"), fakeFamily("unavailable")));
    expect(enforceDown.degraded).toEqual({ reason: "classifier_unavailable" });
  });

  it("records a family that cannot read the content as skipped", async () => {
    const digest = await evaluate(request({ type: "digest", digest: "a".repeat(64), mimeType: "text/plain" }), deps(routed("shadow")));
    expect(digest.route?.classifiers.map((route) => route.skipReason)).toEqual(["digest_content", "digest_content"]);
  });

  it("composes bundle revisions with OpaqueId-safe separators", () => {
    expect(bundleRevision({ revision: "base-1" }, [])).toBe("base-1");
    expect(bundleRevision({ revision: "base-1" }, [{ id: "clef", version: "1.1.0" }, { id: "clairic", version: "0.1.0" }])).toBe("base-1:clef-1.1.0:clairic-0.1.0");
  });
});
