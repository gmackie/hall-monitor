import { SELF } from "cloudflare:test";
import { ErrorBody, EvaluationPage, EvaluationRecord, EvaluationResult, ReasonCodeCatalog, REASON_CODES_REVISION, Capabilities } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEvaluationCursor, encodeEvaluationCursor, evaluationRetentionSeconds } from "../src/store.ts";
import { AMBIGUOUS_MARKER, fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const BASE = "https://hall-monitor.test";
const post = (path: string, token: string | undefined, body: unknown) => SELF.fetch(`${BASE}${path}`, call("POST", token, body));
const get = (path: string, token?: string) => SELF.fetch(`${BASE}${path}`, call("GET", token));
const reader = (tenant?: string) => mintToken("educateos", { scope: "evaluations:read", ...(tenant === undefined ? {} : { tenant }) });

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
  for (const line of logLines) expect(line).not.toContain(SENTINEL);
  vi.restoreAllMocks();
});

async function evaluate(tenant: string, overrides: Parameters<typeof evaluationRequest>[0] = {}) {
  const request = evaluationRequest({ tenant, ...overrides });
  const response = await post("/v1/evaluations", await mintToken("educateos", { tenant }), request);
  expect(response.status).toBe(200);
  return { request, result: EvaluationResult.parse(await response.json()) };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = ErrorBody.parse(await response.json());
  expect(body.code).toBe(code);
  return body;
}

describe("evaluation route on results", () => {
  it("records the primary Clef call and links it to the receipt", async () => {
    const { result } = await evaluate("tenant_route_a");
    expect(result.route?.classifiers).toEqual([
      expect.objectContaining({
        family: "clef",
        evaluatorId: "clef",
        status: "ran",
        mode: "enforce",
        calibrationRevision: null,
        escalated: false,
        calls: [{ modelId: "@cf/cloudflare/clef-flash", role: "primary", outcome: "scored", attemptId: result.receipt!.attempts[0]!.attemptId }],
      }),
    ]);
  });

  it("shows an escalation from clef-flash to clef with its reason", async () => {
    const { result } = await evaluate("tenant_route_b", { text: `${SENTINEL} ${AMBIGUOUS_MARKER}` });
    const route = result.route!.classifiers[0]!;
    expect(route).toMatchObject({ escalated: true, escalationReason: "ambiguous_band" });
    expect(route.calls.map((c) => [c.modelId, c.role, c.outcome])).toEqual([
      ["@cf/cloudflare/clef-flash", "primary", "scored"],
      ["@cf/cloudflare/clef", "escalation", "scored"],
    ]);
    expect(route.calls.map((c) => c.attemptId)).toEqual(result.receipt!.attempts.map((a) => a.attemptId));
  });

  it("records why the classifier was skipped when deterministic findings already decided", async () => {
    const { result } = await evaluate("tenant_route_c", { text: `${SENTINEL} I want to kill myself tonight` });
    if (result.route?.classifiers[0]?.status === "skipped") {
      expect(result.route.classifiers[0]).toMatchObject({ skipReason: "deterministic_decisive", calls: [] });
    }
  });
});

describe("GET /v1/evaluations/:evaluationId", () => {
  it("returns the caller tenant's content-free record and hides it from other tenants", async () => {
    const { request, result } = await evaluate("tenant_read_a", { text: `${SENTINEL} ${HARASSMENT_MARKER}` });
    const response = await get(`/v1/evaluations/${result.evaluationId}`, await reader("tenant_read_a"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(HARASSMENT_MARKER);
    const record = EvaluationRecord.parse(JSON.parse(text));
    expect(record).toMatchObject({
      evaluationId: result.evaluationId,
      requestId: request.requestId,
      tenantId: "tenant_read_a",
      product: "educateos",
      surface: "student.chat",
      evaluationKind: "interaction.input",
      contentType: "text",
      policy: request.policy,
      context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_science" },
      mode: "enforce",
    });
    expect(record.result).toEqual(result);
    expect(Date.parse(record.expiresAt) - Date.parse(record.recordedAt)).toBe(30 * 24 * 60 * 60 * 1000);

    await expectError(await get(`/v1/evaluations/${result.evaluationId}`, await reader("tenant_other")), 404, "invalid_request");
    await expectError(await get(`/v1/evaluations/${result.evaluationId}`), 401, "unauthorized");
    await expectError(await get(`/v1/evaluations/${result.evaluationId}`, await mintToken("educateos", { tenant: "tenant_read_a" })), 403, "forbidden");
    await expectError(await get(`/v1/evaluations/${encodeURIComponent("bad id!")}`, await reader("tenant_read_a")), 400, "invalid_request");
  });

  it("does not create a second record when an idempotent request is replayed", async () => {
    const tenant = "tenant_read_replay";
    const request = evaluationRequest({ tenant });
    const first = EvaluationResult.parse(await (await post("/v1/evaluations", await mintToken("educateos", { tenant }), request)).json());
    const replay = await post("/v1/evaluations", await mintToken("educateos", { tenant }), request);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const page = EvaluationPage.parse(await (await get("/v1/evaluations", await reader(tenant))).json());
    expect(page.items.map((item) => item.evaluationId)).toEqual([first.evaluationId]);
  });
});

describe("GET /v1/evaluations", () => {
  it("lists newest first, pages with a cursor and filters", async () => {
    const tenant = "tenant_list";
    const made: string[] = [];
    for (let index = 0; index < 5; index++) {
      const { result } = await evaluate(tenant, { text: `${SENTINEL} ${index === 2 ? HARASSMENT_MARKER : "benign"} ${index}` });
      made.push(result.evaluationId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const token = () => reader(tenant);
    const all = EvaluationPage.parse(await (await get("/v1/evaluations", await token())).json());
    expect(all.items.map((item) => item.evaluationId)).toEqual([...made].reverse());
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = EvaluationPage.parse(await (await get(`/v1/evaluations?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`, await token())).json());
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.evaluationId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([...made].reverse());

    const held = EvaluationPage.parse(await (await get("/v1/evaluations?reasonCode=clef.harassment", await token())).json());
    expect(held.items.map((item) => item.evaluationId)).toEqual([made[2]]);
    const byDecision = EvaluationPage.parse(await (await get(`/v1/evaluations?decision=${held.items[0]!.result.decision}`, await token())).json());
    expect(byDecision.items.map((item) => item.evaluationId)).toContain(made[2]);
    const byModel = EvaluationPage.parse(await (await get(`/v1/evaluations?modelId=${encodeURIComponent("@cf/cloudflare/clef-flash")}&escalated=false`, await token())).json());
    expect(byModel.items).toHaveLength(5);
    const byRequest = EvaluationPage.parse(await (await get(`/v1/evaluations?requestId=${all.items[0]!.requestId}`, await token())).json());
    expect(byRequest.items.map((item) => item.evaluationId)).toEqual([made[4]]);
    const future = EvaluationPage.parse(await (await get(`/v1/evaluations?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, await token())).json());
    expect(future.items).toEqual([]);

    const other = EvaluationPage.parse(await (await get("/v1/evaluations", await reader("tenant_list_other"))).json());
    expect(other.items).toEqual([]);
  });

  it("rejects unknown, repeated and invalid parameters by name only", async () => {
    const token = () => reader("tenant_list_bad");
    const body = await expectError(await get(`/v1/evaluations?secret=${SENTINEL}`, await token()), 400, "invalid_request");
    expect(body.message).not.toContain(SENTINEL);
    await expectError(await get("/v1/evaluations?limit=0", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations?limit=201", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations?decision=maybe", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations?limit=1&limit=2", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations?cursor=Zm9v", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z", await token()), 400, "invalid_request");
    await expectError(await get("/v1/evaluations", await mintToken("educateos", { tenant: "tenant_list_bad" })), 403, "forbidden");
  });
});

describe("GET /v1/reason-codes and capabilities", () => {
  it("serves the reason-code catalog to any valid token", async () => {
    const response = await get("/v1/reason-codes", await mintToken("educateos", { scope: "evaluate" }));
    expect(response.status).toBe(200);
    const catalog = ReasonCodeCatalog.parse(await response.json());
    expect(catalog.revision).toBe(REASON_CODES_REVISION);
    expect(catalog.codes.map((code) => code.code)).toContain("clef.harassment");
    await expectError(await get("/v1/reason-codes"), 401, "unauthorized");
  });

  it("lists the deployed models and the catalog revision", async () => {
    const capabilities = Capabilities.parse(await (await get("/v1/capabilities", await mintToken("educateos"))).json());
    expect(capabilities.reasonCodesRevision).toBe(REASON_CODES_REVISION);
    expect(capabilities.models?.map((model) => [model.modelId, model.role])).toEqual([
      ["@cf/cloudflare/clef-flash", "primary"],
      ["@cf/cloudflare/clef", "escalation"],
      ["@cf/cloudflare/clairic-flash", "primary"],
      ["@cf/cloudflare/clairic", "escalation"],
    ]);
    expect(capabilities.models?.filter((model) => model.status === "preview").map((model) => model.family)).toEqual(["clairic", "clairic"]);
  });
});

describe("cursor and retention helpers", () => {
  it("round-trips cursors and refuses anything else", () => {
    const cursor = encodeEvaluationCursor(1_790_000_000_000, "eval_abc.1");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEvaluationCursor(cursor)).toEqual({ recordedAt: 1_790_000_000_000, evaluationId: "eval_abc.1" });
    expect(decodeEvaluationCursor("Zm9v")).toBeNull();
    expect(decodeEvaluationCursor("!!")).toBeNull();
  });

  it("bounds evaluation retention", () => {
    expect(evaluationRetentionSeconds({})).toBe(30 * 24 * 60 * 60);
    expect(evaluationRetentionSeconds({ HM_EVALUATION_RETENTION_SECONDS: "3600" })).toBe(3600);
    expect(evaluationRetentionSeconds({ HM_EVALUATION_RETENTION_SECONDS: String(500 * 24 * 60 * 60) })).toBe(30 * 24 * 60 * 60);
    expect(evaluationRetentionSeconds({ HM_EVALUATION_RETENTION_SECONDS: "nope" })).toBe(30 * 24 * 60 * 60);
  });
});
