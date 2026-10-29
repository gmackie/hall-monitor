import { SELF } from "cloudflare:test";
import { Capabilities, ErrorBody, EvaluationResult, MAX_IMAGE_BYTES } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EVALUATION_BYTES } from "../src/app.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const BASE = "https://hall-monitor.test";
const post = async (body: unknown) => SELF.fetch(`${BASE}/v1/evaluations`, call("POST", await mintToken("educateos"), body));

/**
 * A synthetic PNG: the PNG signature followed by marker bytes, so its base64 contains a
 * recognizable run that must never appear in a log line, result or error.
 */
const IMAGE_BASE64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + `${SENTINEL}-IMAGE-BYTES`.repeat(8));
const IMAGE_MARKER = IMAGE_BASE64.slice(24, 72);

let logLines: string[] = [];
beforeEach(() => {
  fakeAi.reset();
  logLines = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  for (const line of logLines) {
    expect(line).not.toContain(SENTINEL);
    expect(line).not.toContain(IMAGE_MARKER);
  }
  vi.restoreAllMocks();
});

function imageRequest(profile: "educator" | "student-9-12", text?: string) {
  const base = evaluationRequest({ kind: "content.candidate" });
  return {
    ...base,
    policy: { profileId: profile, revision: "builtin-1" },
    context: profile === "educator" ? { audience: "educator" as const, costCenterId: "cc_staff" } : base.context,
    content: { type: "image" as const, images: [{ mimeType: "image/png" as const, base64: IMAGE_BASE64 }], ...(text === undefined ? {} : { text }) },
  };
}

describe("image content", () => {
  it("classifies an educator's images with Clef-flash and receipts the reported tokens", async () => {
    const response = await post(imageRequest("educator", `${SENTINEL} unit opener`));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(IMAGE_MARKER);
    expect(body).not.toContain(SENTINEL);
    const result = EvaluationResult.parse(JSON.parse(body));
    expect(result).toMatchObject({ decision: "allow", evaluatorBundleRevision: "base-1.0.1:clef-1.1.0" });
    expect(fakeAi.calls.map((entry) => entry.model)).toEqual(["@cf/cloudflare/clef-flash"]);
    expect(fakeAi.calls[0]!.input).toMatchObject({ model: "clef-flash", images: [{ content_type: "image/png", base64: IMAGE_BASE64 }] });
    expect(result.receipt).toMatchObject({ totalGrossUsdNano: "24320", hasUnknownCost: false });
    // Gateway metadata stays content-free.
    expect(JSON.stringify(fakeAi.calls[0]!.options ?? {})).not.toContain(IMAGE_MARKER);
  });

  it("holds a student's images without a classifier call while student image moderation is off", async () => {
    const result = EvaluationResult.parse(await (await post(imageRequest("student-9-12"))).json());
    expect(fakeAi.calls).toHaveLength(0);
    expect(result).toMatchObject({ decision: "hold", degraded: { reason: "classifier_unavailable" }, receipt: null });
    expect(result.reasonCodes).toEqual(["hall_monitor.unavailable", "hall_monitor.image_moderation_disabled"]);
  });

  it("replays an image evaluation by idempotency key without re-sending the images", async () => {
    const request = imageRequest("educator");
    expect((await post(request)).status).toBe(200);
    const replay = await post(request);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(fakeAi.calls).toHaveLength(1);
  });

  it("rejects malformed image content naming fields only", async () => {
    const mislabelled = { ...imageRequest("educator"), content: { type: "image", images: [{ mimeType: "image/jpeg", base64: IMAGE_BASE64 }] } };
    const response = await post(mislabelled);
    expect(response.status).toBe(400);
    const body = ErrorBody.parse(await response.json());
    expect(body.code).toBe("invalid_request");
    expect(body.message).toContain("content");
    expect(body.message).not.toContain(IMAGE_MARKER);
  });

  it("accepts a body with a full-size image and refuses one over the body limit", async () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const large = { ...imageRequest("educator"), content: { type: "image", images: [{ mimeType: "image/png", base64: btoa(binary) }] } };
    expect((await post(large)).status).toBe(200);

    const oversize = SELF.fetch(`${BASE}/v1/evaluations`, {
      method: "POST",
      headers: { authorization: `Bearer ${await mintToken("educateos")}`, "content-type": "application/json" },
      body: "x".repeat(MAX_EVALUATION_BYTES + 1),
    });
    const response = await oversize;
    expect(response.status).toBe(413);
  });

  it("advertises image content in capabilities", async () => {
    const response = await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", await mintToken("educateos")));
    expect(Capabilities.parse(await response.json()).contentTypes).toEqual(["text", "digest", "image"]);
  });
});
