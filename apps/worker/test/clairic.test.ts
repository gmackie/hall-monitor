import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatedProfile } from "../src/model-gate.ts";
import { fakeAi, PII_MARKER } from "./fake-ai.ts";
import { call, direct, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const TENANT = "tenant_clairic";
const overlays = (mode: "shadow" | "enforce") =>
  JSON.stringify({ [TENANT]: { "student-9-12": { revision: `clairic-${mode}`, routing: { clairic: { enabled: true, mode } } } } });

beforeEach(() => {
  fakeAi.reset();
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

async function evaluate(mode: "shadow" | "enforce", extra: Record<string, string> = {}) {
  const request = evaluationRequest({ tenant: TENANT, text: `${SENTINEL} reach me at ${PII_MARKER}` });
  request.policy = { profileId: "student-9-12", revision: `clairic-${mode}` };
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos", { tenant: TENANT }), request), {
    HM_POLICY_OVERLAYS: overlays(mode),
    ...extra,
  } as never);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(PII_MARKER);
  return EvaluationResult.parse(JSON.parse(text));
}

describe("Clairic routing in the Worker", () => {
  it("runs Clairic beside Clef in shadow, receipting it but leaving the decision to Clef", async () => {
    const result = await evaluate("shadow");
    expect(fakeAi.calls.map((entry) => entry.model).sort()).toEqual(["@cf/cloudflare/clairic-flash", "@cf/cloudflare/clef-flash"]);
    const route = result.route!.classifiers.find((entry) => entry.family === "clairic")!;
    expect(route).toMatchObject({ status: "ran", mode: "shadow", calls: [{ modelId: "@cf/cloudflare/clairic-flash", outcome: "scored" }] });
    expect(route.shadowFindings?.[0]).toMatchObject({ reasonCode: "clairic.personal_identifier", evidence: [{ field: "personal_identifier" }] });
    expect(result.findings.some((finding) => finding.evaluatorId === "clairic")).toBe(false);
    expect(result.receipt?.attempts.map((attempt) => attempt.priceBookId)).toEqual(["cloudflare-2026-11-22", "cloudflare-2026-11-22"]);
  });

  it("holds a preview family to shadow when a profile asks to enforce it, unless the owner waived the gate", async () => {
    const gated = await evaluate("enforce");
    expect(gated.route!.classifiers.find((entry) => entry.family === "clairic")!.mode).toBe("shadow");
    const waived = await evaluate("enforce", { HM_MODEL_ENFORCE_WAIVERS: JSON.stringify(["clairic"]) });
    expect(waived.route!.classifiers.find((entry) => entry.family === "clairic")!.mode).toBe("enforce");
    expect(waived.reasonCodes).toContain("clairic.personal_identifier");
    expect(waived.decision).toBe("hold");
  });

  it("does not call Clairic under a profile that leaves it off", async () => {
    const request = evaluationRequest({ tenant: TENANT });
    const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos", { tenant: TENANT }), request));
    const result = EvaluationResult.parse(await response.json());
    expect(fakeAi.calls.map((entry) => entry.model)).toEqual(["@cf/cloudflare/clef-flash"]);
    expect(result.route!.classifiers.map((entry) => [entry.family, entry.status, entry.skipReason])).toEqual([
      ["clef", "ran", undefined],
      ["clairic", "skipped", "profile_disabled"],
    ]);
    expect(result.evaluatorBundleRevision).toBe("base-1.0.1:clef-1.1.0");
  });
});

describe("gatedProfile", () => {
  const enforce = { ...STUDENT_9_12_PROFILE, routing: { clairic: { enabled: true, mode: "enforce" as const } } };
  it("shadows preview families and keeps waived or GA ones", () => {
    expect(gatedProfile(enforce, {}).routing?.clairic?.mode).toBe("shadow");
    expect(gatedProfile(enforce, { HM_MODEL_ENFORCE_WAIVERS: "[\"clairic\"]" }).routing?.clairic?.mode).toBe("enforce");
    expect(gatedProfile(enforce, { HM_MODEL_ENFORCE_WAIVERS: "not json" }).routing?.clairic?.mode).toBe("shadow");
    expect(gatedProfile(STUDENT_9_12_PROFILE, {})).toBe(STUDENT_9_12_PROFILE);
  });
});
