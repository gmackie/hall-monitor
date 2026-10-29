import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { BASELINE_DECISION_PACK_PIN } from "@gmacko/hall-monitor-noul-registry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeAi } from "./fake-ai.ts";
import { call, direct, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

let logs: string[];
beforeEach(() => {
  fakeAi.reset(); logs = [];
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterEach(() => {
  expect(logs.join("\n")).not.toContain(SENTINEL);
  vi.restoreAllMocks();
});

it.each([
  ["malformed", SENTINEL], ["empty", ""], ["missing", "{}"],
  ["unknown pack", JSON.stringify({ ...BASELINE_DECISION_PACK_PIN, id: "missing" })],
  ["unknown version", JSON.stringify({ ...BASELINE_DECISION_PACK_PIN, version: "2.0.0" })],
  ["tampered digest", JSON.stringify({ ...BASELINE_DECISION_PACK_PIN, digest: "sha256:" + "a".repeat(64) })],
])("%s configured pack makes no inference and retains required student hold", async (_label, HM_DECISION_PACK) => {
  const extra = { HM_DECISION_PACK, AI: fakeAi };
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), extra);
  expect(response.status).toBe(200);
  const result = EvaluationResult.parse(await response.json());
  expect(result.decision).toBe("hold");
  expect(result.degraded?.reason).toBe("classifier_unavailable");
  expect(result.receipt?.attempts ?? []).toHaveLength(0);
  expect(fakeAi.calls).toHaveLength(0);
  const ready = await direct("/v1/ready", call("GET", await mintToken("educateos")), extra);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toMatchObject({ checks: { decisionPack: false } });
  const capabilities = await direct("/v1/capabilities", call("GET", await mintToken("educateos")), extra);
  expect(await capabilities.json()).toMatchObject({ classifier: { enabled: false } });
  expect(fakeAi.calls).toHaveLength(0);
});

it("accepts the exact server pin, and a later invalid setting cannot reuse the cached valid pack", async () => {
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), {
    AI: fakeAi, HM_DECISION_PACK: JSON.stringify(BASELINE_DECISION_PACK_PIN),
  });
  expect(response.status).toBe(200);
  expect(EvaluationResult.parse(await response.json()).decision).toBe("allow");
  expect(fakeAi.calls).toHaveLength(1);
  const ready = await direct("/v1/ready", call("GET", await mintToken("educateos")), { AI: fakeAi, HM_DECISION_PACK: "{}" });
  expect(ready.status).toBe(503);
  expect(fakeAi.calls).toHaveLength(1);
});

it("keeps the deterministic support path available when the classifier pack is invalid", async () => {
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"),
    evaluationRequest({ text: `${SENTINEL} I want to die. Nothing ever gets better.` })), { AI: fakeAi, HM_DECISION_PACK: "{}" });
  expect(response.status).toBe(200);
  expect(EvaluationResult.parse(await response.json()).decision).toBe("support");
  expect(fakeAi.calls).toHaveLength(0);
});
