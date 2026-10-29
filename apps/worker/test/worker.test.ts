import { SELF } from "cloudflare:test";
import { CostReceipt, ErrorBody, EvaluationResult, ReceiptRecord } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, direct, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const BASE = "https://hall-monitor.test";
const post = (path: string, token: string | undefined, body: unknown) => SELF.fetch(`${BASE}${path}`, call("POST", token, body));
const get = (path: string, token?: string) => SELF.fetch(`${BASE}${path}`, call("GET", token));

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
  // No log line may ever carry request content.
  for (const line of logLines) expect(line).not.toContain(SENTINEL);
  vi.restoreAllMocks();
});

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = ErrorBody.parse(await response.json());
  expect(body.code).toBe(code);
  expect(body.message).not.toContain(SENTINEL);
  return body;
}

describe("service authentication (fail closed)", () => {
  it("rejects a missing token with 401", async () => {
    const response = await post("/v1/evaluations", undefined, evaluationRequest());
    await expectError(response, 401, "unauthorized");
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(fakeAi.calls).toHaveLength(0);
  });

  it("rejects malformed tokens and unsupported algorithms with 401", async () => {
    const valid = await mintToken("educateos");
    const [header, payload] = valid.split(".");
    const none = `${btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")}.${payload}.`;
    const hs256 = `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "")}.${payload}.c2ln`;
    for (const token of ["not-a-jwt", `${header}.${payload}`, none, hs256, `${valid}x`]) {
      await expectError(await post("/v1/evaluations", token, evaluationRequest()), 401, "unauthorized");
    }
  });

  it("rejects a token signed by an untrusted key that reuses a trusted kid", async () => {
    await expectError(await post("/v1/evaluations", await mintToken("rogue"), evaluationRequest()), 401, "unauthorized");
  });

  it("rejects expired, not-yet-valid, wrong-audience, unknown-issuer and jti-less tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { claims: { exp: now - 61, iat: now - 400 } },
      { claims: { nbf: now + 120 } },
      { claims: { aud: "some-other-service" } },
      { claims: { iss: "https://unknown.test/issuer" } },
      { claims: { jti: undefined } },
      { claims: { tenant: undefined } },
      { claims: { exp: undefined } },
    ];
    for (const options of cases) {
      await expectError(await post("/v1/evaluations", await mintToken("educateos", options), evaluationRequest()), 401, "unauthorized");
    }
    expect(logLines.some((line) => line.includes('"event":"auth.rejected"') && line.includes('"authFailure":"expired"'))).toBe(true);
  });

  it("accepts a token within the 60 second clock skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintToken("educateos", { claims: { exp: now - 30, iat: now - 300 } });
    expect((await post("/v1/evaluations", token, evaluationRequest())).status).toBe(200);
  });

  it("returns 403 when the request's tenant is not the token's", async () => {
    const token = await mintToken("educateos", { tenant: "tenant_educateos" });
    await expectError(await post("/v1/evaluations", token, evaluationRequest({ tenant: "tenant_playtrek" })), 403, "forbidden");
    expect(fakeAi.calls).toHaveLength(0);
  });

  it("returns 403 when the token lacks the required scope", async () => {
    const readOnly = await mintToken("educateos", { scope: "receipts:read" });
    await expectError(await post("/v1/evaluations", readOnly, evaluationRequest()), 403, "forbidden");
    const evaluateOnly = await mintToken("educateos", { scope: ["evaluate"] });
    await expectError(await get("/v1/receipts/eval_any", evaluateOnly), 403, "forbidden");
  });

  it("verifies ES256 tokens and per-issuer audiences", async () => {
    const token = await mintToken("playtrek", { tenant: "tenant_playtrek", claims: { aud: ["hall-monitor-playtrek"] } });
    const request = evaluationRequest({ tenant: "tenant_playtrek" });
    expect((await post("/v1/evaluations", token, { ...request, source: { ...request.source, product: "playtrek" } })).status).toBe(200);
  });
  it("accepts EducateOS under its product id and issuer, and rejects the retired schoolos product and issuer", async () => {
    const request = evaluationRequest();
    expect(request.source.product).toBe("educateos");
    const response = await post("/v1/evaluations", await mintToken("educateos"), request);
    expect(response.status).toBe(200);
    const result = EvaluationResult.parse(await response.json());
    expect(result.decision).toBe("allow");
    expect(CostReceipt.parse(result.receipt).product).toBe("educateos");
    // The `schoolos` product alias is gone from the wire contract (HM-14).
    const legacyProduct = evaluationRequest();
    await expectError(await post("/v1/evaluations", await mintToken("educateos"), { ...legacyProduct, source: { ...legacyProduct.source, product: "schoolos" } }), 400, "invalid_request");
    // So is the `schoolos` issuer, even with EducateOS's own key.
    await expectError(await post("/v1/evaluations", await mintToken("schoolos"), evaluationRequest()), 401, "unauthorized");
  });
});

describe("POST /v1/evaluations", () => {
  it("allows benign student input after one Clef-flash call, with a priced receipt", async () => {
    const request = evaluationRequest();
    const response = await post("/v1/evaluations", await mintToken("educateos"), request);
    expect(response.status).toBe(200);
    const result = EvaluationResult.parse(await response.json());
    expect(result).toMatchObject({ requestId: request.requestId, decision: "allow", uncertain: false, policyRevision: "builtin-1" });
    expect(result.evaluatorBundleRevision).toBe("base-1.0.1:clef-1.1.0");
    expect(fakeAi.calls.map((entry) => entry.model)).toEqual(["@cf/cloudflare/clef-flash"]);
    const receipt = CostReceipt.parse(result.receipt);
    expect(receipt).toMatchObject({ tenantId: "tenant_educateos", purpose: "moderation.input", hasUnknownCost: false });
    // 640 input tokens at $0.038 per million = 24,320 nanodollars; output tokens are free.
    expect(receipt.totalGrossUsdNano).toBe("24320");
    expect(receipt.attempts[0]).toMatchObject({ units: { inputTokens: 640 }, state: "provider_reported" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(logLines.some((line) => line.includes('"event":"evaluation.completed"') && line.includes('"decision":"allow"'))).toBe(true);
  });

  it("holds student input the classifier flags as harassment", async () => {
    const request = evaluationRequest({ text: `${SENTINEL} ${HARASSMENT_MARKER}` });
    const result = EvaluationResult.parse(await (await post("/v1/evaluations", await mintToken("educateos"), request)).json());
    expect(result.decision).toBe("hold");
    expect(result.reasonCodes).toContain("clef.harassment");
  });

  it("replays the stored result for a repeated key without calling the classifier again", async () => {
    const token = () => mintToken("educateos");
    const request = evaluationRequest();
    const first = await post("/v1/evaluations", await token(), request);
    const firstBody = await first.text();
    const second = await post("/v1/evaluations", await mintToken("educateos"), structuredClone(request));
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(firstBody);
    expect(fakeAi.calls).toHaveLength(1);
  });

  it("replays regardless of the caller's JSON key order", async () => {
    const token = () => mintToken("educateos");
    const request = evaluationRequest();
    await post("/v1/evaluations", await token(), request);
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect((await post("/v1/evaluations", await token(), reordered)).headers.get("idempotent-replayed")).toBe("true");
    expect(fakeAi.calls).toHaveLength(1);
  });

  it("returns 409 when a key is reused for a different request", async () => {
    const token = () => mintToken("educateos");
    const request = evaluationRequest();
    await post("/v1/evaluations", await token(), request);
    const reused = { ...request, content: { type: "text", text: `${SENTINEL} a different question` } };
    const body = await expectError(await post("/v1/evaluations", await token(), reused), 409, "idempotency_conflict");
    expect(body.retryable).toBe(false);
    expect(fakeAi.calls).toHaveLength(1);
  });

  it("scopes idempotency keys by tenant", async () => {
    const educateos = evaluationRequest({ tenant: "tenant_educateos" });
    const other = { ...evaluationRequest({ tenant: "tenant_other" }), idempotencyKey: educateos.idempotencyKey };
    await post("/v1/evaluations", await mintToken("educateos", { tenant: "tenant_educateos" }), educateos);
    const response = await post("/v1/evaluations", await mintToken("educateos", { tenant: "tenant_other" }), other);
    expect(response.status).toBe(200);
    expect(response.headers.get("idempotent-replayed")).toBeNull();
  });

  it("releases the key when an evaluation fails, so a retry can succeed", async () => {
    const token = () => mintToken("educateos");
    const request = { ...evaluationRequest(), policy: { profileId: "no-such-profile", revision: "builtin-1" } };
    await expectError(await post("/v1/evaluations", await token(), request), 404, "policy_not_found");
    await expectError(await post("/v1/evaluations", await token(), request), 404, "policy_not_found");
  });

  it("rejects invalid requests naming fields only, never values", async () => {
    const token = () => mintToken("educateos");
    const request = evaluationRequest();
    const body = await expectError(
      await post("/v1/evaluations", await token(), { ...request, context: { ...request.context, gradeBand: SENTINEL } }),
      400,
      "invalid_request",
    );
    expect(body.message).toContain("context.gradeBand");
    await expectError(await post("/v1/evaluations", await token(), { ...request, schemaVersion: "2.0" }), 400, "unsupported_schema");
    const raw = await SELF.fetch(`${BASE}/v1/evaluations`, { method: "POST", headers: { authorization: `Bearer ${await token()}` }, body: `{${SENTINEL}` });
    await expectError(raw, 400, "invalid_request");
  });

  it("holds student input when the classifier fails", async () => {
    fakeAi.failing = true;
    const result = EvaluationResult.parse(await (await post("/v1/evaluations", await mintToken("educateos"), evaluationRequest())).json());
    expect(result).toMatchObject({ decision: "hold", degraded: { reason: "classifier_unavailable" } });
    expect(result.receipt?.hasUnknownCost).toBe(true);
  });

  it("fails closed to hold for a student profile when the AI binding is absent", async () => {
    const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()));
    const result = EvaluationResult.parse(await response.json());
    expect(result).toMatchObject({ decision: "hold", uncertain: true, degraded: { reason: "classifier_unavailable" }, receipt: null });
    expect(result.reasonCodes).toContain("hall_monitor.unavailable");
    expect(result.evaluatorBundleRevision).toBe("base-1.0.1");
  });

  it("returns 429 when the tenant's rate limit is exhausted", async () => {
    const keys: string[] = [];
    const limiter = {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: false };
      },
    };
    const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { TENANT_RATE_LIMITER: limiter });
    const body = await expectError(response, 429, "rate_limited");
    expect(body.retryable).toBe(true);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(keys).toEqual(["tenant_educateos"]);
  });
});

describe("policy overlays", () => {
  it("pins a tenant with an overlay to the overlay revision and clamps weakening fields", async () => {
    const token = () => mintToken("educateos", { tenant: "tenant_overlay" });
    const educator = {
      ...evaluationRequest({ tenant: "tenant_overlay", kind: "interaction.output" }),
      policy: { profileId: "educator", revision: "builtin-1" },
      context: { audience: "educator" as const, costCenterId: "cc_staff" },
    };
    await expectError(await post("/v1/evaluations", await token(), educator), 404, "policy_not_found");
    const pinned = { ...educator, idempotencyKey: `${educator.idempotencyKey}_2`, policy: { profileId: "educator", revision: "district-7:3" } };
    const result = EvaluationResult.parse(await (await post("/v1/evaluations", await token(), pinned)).json());
    expect(result.policyRevision).toBe("district-7:3");
    // The overlay made output moderation required, so the classifier ran on output.
    expect(fakeAi.calls).toHaveLength(1);

    const capabilities = (await (await get("/v1/capabilities", await token())).json()) as { policyProfiles: { id: string; revision: string }[] };
    expect(capabilities.policyProfiles).toContainEqual({ id: "educator", revision: "district-7:3" });
  });
});

describe("POST /v1/evaluations:batch", () => {
  it("evaluates offline kinds in order, with per-item errors", async () => {
    const token = () => mintToken("educateos");
    const candidate = (text: string) => ({
      ...evaluationRequest({ kind: "content.candidate", text }),
      policy: { profileId: "published-content", revision: "builtin-1" },
      context: { audience: "public" as const, costCenterId: "cc_publishing" },
    });
    const missing = { ...candidate(`${SENTINEL} third`), policy: { profileId: "missing", revision: "builtin-1" } };
    const requests = [candidate(`${SENTINEL} first`), candidate(`${SENTINEL} second ${HARASSMENT_MARKER}`), missing];
    const response = await post("/v1/evaluations:batch", await token(), { requests });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { status: string; result?: EvaluationResult; error?: { code: string } }[] };
    expect(body.items.map((item) => item.status)).toEqual(["ok", "ok", "error"]);
    expect(body.items[0]!.result!.requestId).toBe(requests[0]!.requestId);
    expect(body.items[1]!.result!.decision).toBe("hold");
    expect(body.items[2]!.error!.code).toBe("policy_not_found");
  });

  it("rejects interactive kinds, oversize batches and other tenants' requests", async () => {
    const token = () => mintToken("educateos");
    await expectError(await post("/v1/evaluations:batch", await token(), { requests: [evaluationRequest({ kind: "interaction.input" })] }), 400, "invalid_request");
    await expectError(await post("/v1/evaluations:batch", await token(), { requests: [evaluationRequest({ kind: "interaction.output" })] }), 400, "invalid_request");
    const many = Array.from({ length: 51 }, () => evaluationRequest({ kind: "content.candidate" }));
    await expectError(await post("/v1/evaluations:batch", await token(), { requests: many }), 400, "invalid_request");
    await expectError(await post("/v1/evaluations:batch", await token(), { requests: [] }), 400, "invalid_request");
    const foreign = evaluationRequest({ kind: "content.candidate", tenant: "tenant_playtrek" });
    await expectError(await post("/v1/evaluations:batch", await token(), { requests: [foreign] }), 403, "forbidden");
    expect(fakeAi.calls).toHaveLength(0);
  });
});

describe("GET /v1/receipts/:evaluationId", () => {
  it("returns the caller tenant's receipt record and hides it from other tenants", async () => {
    const result = EvaluationResult.parse(await (await post("/v1/evaluations", await mintToken("educateos"), evaluationRequest())).json());
    const own = await get(`/v1/receipts/${result.evaluationId}`, await mintToken("educateos"));
    expect(own.status).toBe(200);
    const record = ReceiptRecord.parse(await own.json());
    expect(record).toMatchObject({ evaluationId: result.evaluationId, requestId: result.requestId, tenantId: "tenant_educateos", receipt: result.receipt });

    const other = await get(`/v1/receipts/${result.evaluationId}`, await mintToken("educateos", { tenant: "tenant_other" }));
    await expectError(other, 404, "invalid_request");
    await expectError(await get(`/v1/receipts/${result.evaluationId}`), 401, "unauthorized");
    await expectError(await get(`/v1/receipts/${encodeURIComponent("bad id!")}`, await mintToken("educateos")), 400, "invalid_request");
  });
});

describe("health, readiness and capabilities", () => {
  it("serves a public health check that reveals nothing tenant-specific", async () => {
    const anonymous = await get("/v1/health");
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ status: "ok" });
    const authenticated = await get("/v1/health", await mintToken("educateos", { tenant: "tenant_overlay" }));
    expect(await authenticated.json()).toEqual({ status: "ok" });
  });

  it("requires authentication for readiness and checks the AI binding without calling it", async () => {
    await expectError(await get("/v1/ready"), 401, "unauthorized");
    const token = () => mintToken("educateos");
    const ready = await get("/v1/ready", await token());
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ready: true,
      checks: { authentication: true, policyOverlays: true, tenantModes: true, idempotencyStore: true, replayGuard: true, classifier: true, decisionPack: true, governanceConfig: true },
    });
    const missingAi = await direct("/v1/ready", call("GET", await token()));
    expect(missingAi.status).toBe(503);
    expect(((await missingAi.json()) as { checks: { classifier: boolean } }).checks.classifier).toBe(false);
    expect(fakeAi.calls).toHaveLength(0);
  });

  it("describes the deployment to an authenticated caller", async () => {
    await expectError(await get("/v1/capabilities"), 401, "unauthorized");
    const body = (await (await get("/v1/capabilities", await mintToken("educateos"))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "1.0",
      resolverVersion: "resolver-1.0.0",
      classifier: { enabled: true, models: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"] },
    });
    expect(body.policyProfiles).toContainEqual({ id: "student-9-12", revision: "builtin-1" });
  });

  it("answers unknown routes and wrong methods with wire errors", async () => {
    await expectError(await get("/v1/nope"), 404, "invalid_request");
    await expectError(await get("/v1/evaluations"), 405, "invalid_request");
  });

  it("fails closed when no issuers are configured", async () => {
    const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { HM_TRUSTED_ISSUERS: "" });
    await expectError(response, 503, "unavailable");
    // A configured private key member is refused outright rather than silently stripped.
    const withPrivate = JSON.stringify([{ iss: "https://educateos.test/issuer", jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "AA", d: "AA" }] } }]);
    const refused = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { HM_TRUSTED_ISSUERS: withPrivate });
    await expectError(refused, 503, "unavailable");
  });
});
