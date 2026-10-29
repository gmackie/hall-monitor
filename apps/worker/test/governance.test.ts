import { CLEF_QUESTIONS } from "@gmacko/hall-monitor-clef";
import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import type { GovernanceContext } from "@gmacko/hall-monitor-governance";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config as fixture, context as fixtureContext } from "../../../packages/governance/__tests__/fixtures.ts";
import type { Env } from "../src/env.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, direct, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

let lines: string[];
beforeEach(() => {
  fakeAi.reset(); lines = [];
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a) => { lines.push(a.join(" ")); });
});
afterEach(() => { expect(lines.join("\n")).not.toContain(SENTINEL); vi.restoreAllMocks(); });

function setup() {
  const now = Math.floor(Date.now() / 1000);
  const c = fixture(), e = c.tenants.tenant_synthetic!, a = c.evidence.tenant_synthetic!;
  e.approvedFrom = now - 100; e.approvedUntil = now + 1000; e.issuers = ["https://educateos.test/issuer"];
  a.checkedAt = now - 10; a.expiresAt = now + 500;
  const req = evaluationRequest({ source: { product: "other", tenantId: "tenant_synthetic", surface: "synthetic.chat" } });
  const context: GovernanceContext = { ...fixtureContext(), requestId: req.requestId, issuedAt: now - 1, expiresAt: now + 120 };
  const env: { -readonly [K in keyof Env]?: Env[K] } = { AI: fakeAi, FG_COMMIT_HASH: e.route.sourceRevision, HM_GOVERNANCE_ACCOUNT_ID: e.route.accountId, HM_GOVERNANCE_WORKER_NAME: e.route.workerName };
  return { c, context, req, env, now };
}
async function post(s: ReturnType<typeof setup>, claims: unknown = s.context, path = "/v1/evaluations:governed") {
  const token = await mintToken("educateos", { tenant: "tenant_synthetic", claims: claims === undefined ? {} : { hm_governance: claims } });
  return direct(path, call("POST", token, s.req), { ...s.env, HM_GOVERNANCE: JSON.stringify(s.c) });
}

it.each([undefined, "{}", "not-json"])("required governance refuses absent or malformed config %s", async (setting) => {
  const s = setup(), token = await mintToken("educateos", { tenant: "tenant_synthetic", claims: { hm_governance: s.context } });
  const response = await direct("/v1/evaluations:governed", call("POST", token, s.req), { ...s.env, ...(setting === undefined ? {} : { HM_GOVERNANCE: setting }) });
  expect(response.status).toBe(setting === undefined ? 403 : 503);
  expect(fakeAi.calls).toHaveLength(0);
});

it("requires signed context instead of a body or header assertion", async () => {
  const s = setup(), init = call("POST", await mintToken("educateos", { tenant: "tenant_synthetic" }), { ...s.req, hm_governance: s.context });
  const response = await direct("/v1/evaluations:governed", { ...init, headers: { ...init.headers, "x-hm-require-governance": "true" } }, { ...s.env, HM_GOVERNANCE: JSON.stringify(s.c) });
  expect(response.status).toBe(403); expect(fakeAi.calls).toHaveLength(0);
});

it.each(["/v1/evaluations", "/v1/evaluations:governed"])("refuses a signed claim without enrollment on %s", async (path) => {
  const s = setup(); delete s.c.tenants.tenant_synthetic;
  expect((await post(s, s.context, path)).status).toBe(403); expect(fakeAi.calls).toHaveLength(0);
});

it("rejects malformed signed context and other methods on the governed endpoint", async () => {
  const s = setup();
  expect((await post(s, { ...s.context, dateOfBirth: "2000-01-01" })).status).toBe(401);
  expect((await direct("/v1/evaluations:governed", call("GET", undefined))).status).toBe(405);
  expect(fakeAi.calls).toHaveLength(0);
});

it("preserves unenrolled legacy evaluations without signed governance context", async () => {
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { AI: fakeAi });
  expect(EvaluationResult.parse(await response.json()).decision).toBe("allow"); expect(fakeAi.calls).toHaveLength(1);
});

it("never replays a legacy result as a governed evaluation", async () => {
  const s = setup();
  const legacy = await direct("/v1/evaluations", call("POST", await mintToken("educateos", { tenant: "tenant_synthetic" }), s.req), s.env);
  expect(legacy.status).toBe(200); expect(fakeAi.calls).toHaveLength(1);
  expect((await post(s)).status).toBe(409); expect(fakeAi.calls).toHaveLength(1);
});

it("replays fresh tokens once, refuses changed authority, and rechecks revocation", async () => {
  const s = setup(), first = await post(s);
  expect(first.status).toBe(200); const result = await first.json();
  const replay = await post(s, { ...s.context, issuedAt: s.now, expiresAt: s.now + 180 });
  expect(replay.headers.get("idempotent-replayed")).toBe("true"); expect(await replay.json()).toEqual(result);
  expect((await post(s, { ...s.context, eligibilityRef: "another" })).status).toBe(409);
  s.c.tenants.tenant_synthetic!.revoked = true;
  expect((await post(s)).status).toBe(403); expect(fakeAi.calls).toHaveLength(1);
});

it("refuses expired signed authority before replaying a committed allow", async () => {
  const s = setup(); expect((await post(s)).status).toBe(200);
  expect((await post(s, { ...s.context, expiresAt: s.now })).status).toBe(403);
  expect(fakeAi.calls).toHaveLength(1);
});

it("allows a verified synthetic request and meters its actual model call", async () => {
  const response = await post(setup());
  expect(response.status).toBe(200);
  const result = EvaluationResult.parse(await response.json());
  expect(result.decision).toBe("allow"); expect(result.receipt?.attempts).toHaveLength(1);
  expect(fakeAi.calls).toHaveLength(1);
});

it.each([
  ["expired approval", (s: ReturnType<typeof setup>) => { s.c.tenants.tenant_synthetic!.approvedUntil = s.now; }],
  ["revocation", (s: ReturnType<typeof setup>) => { s.c.tenants.tenant_synthetic!.revoked = true; }],
  ["stale evidence", (s: ReturnType<typeof setup>) => { s.c.evidence.tenant_synthetic!.expiresAt = s.now; }],
  ["missing evidence", (s: ReturnType<typeof setup>) => { delete s.c.evidence.tenant_synthetic; }],
  ["unverified export", (s: ReturnType<typeof setup>) => { s.c.evidence.tenant_synthetic!.observations.accountLogpush = "unverified"; }],
  ["policy mismatch", (s: ReturnType<typeof setup>) => { s.context = { ...s.context, policyRevision: "other" }; }],
  ["other purpose", (s: ReturnType<typeof setup>) => { s.context = { ...s.context, purpose: "marketing" }; }],
  ["unknown eligibility", (s: ReturnType<typeof setup>) => { s.context = { ...s.context, ageEligibility: "unknown" }; }],
  ["expired eligibility", (s: ReturnType<typeof setup>) => { s.context = { ...s.context, expiresAt: s.now }; }],
  ["wrong issuer", (s: ReturnType<typeof setup>) => { s.c.tenants.tenant_synthetic!.issuers = ["https://other.test/issuer"]; }],
  ["wrong request", (s: ReturnType<typeof setup>) => { s.context = { ...s.context, requestId: "unrelated" }; }],
  ["wrong account", (s: ReturnType<typeof setup>) => { s.env.HM_GOVERNANCE_ACCOUNT_ID = "c".repeat(32); }],
  ["gateway drift", (s: ReturnType<typeof setup>) => { s.env.HM_AI_GATEWAY_ID = "unapproved"; }],
] as const)("%s makes zero calls and keeps the student hold", async (_label, mutate) => {
  const s = setup(); mutate(s);
  const response = await post(s);
  expect(response.status).toBe(200);
  const result = EvaluationResult.parse(await response.json());
  expect(result).toMatchObject({ decision: "hold", degraded: { reason: "classifier_unavailable" }, receipt: null });
  expect(fakeAi.calls).toHaveLength(0);
});

it("browser/body context cannot replace a missing signed eligibility extension", async () => {
  const s = setup();
  const req = { ...s.req, hm_governance: s.context };
  const token = await mintToken("educateos", { tenant: "tenant_synthetic" });
  const response = await direct("/v1/evaluations", call("POST", token, req), { ...s.env, HM_GOVERNANCE: JSON.stringify(s.c) });
  expect(EvaluationResult.parse(await response.json()).decision).toBe("hold"); expect(fakeAi.calls).toHaveLength(0);
});

it("denied governance keeps deterministic distress support reachable", async () => {
  const s = setup(); s.c.tenants.tenant_synthetic!.revoked = true;
  s.req = { ...s.req, content: { type: "text", text: `${SENTINEL} I want to die.` } };
  const response = await post(s);
  expect(EvaluationResult.parse(await response.json()).decision).toBe("support"); expect(fakeAi.calls).toHaveLength(0);
});

it("a shadow override cannot turn a governed denial into an unmoderated allow", async () => {
  const s = setup(); s.c.tenants.tenant_synthetic!.revoked = true;
  s.env.HM_TENANT_MODES = JSON.stringify({ tenant_synthetic: { mode: "shadow", allowStudentShadow: true } });
  const response = await post(s);
  const result = EvaluationResult.parse(await response.json());
  expect(result.decision).toBe("hold"); expect(result.shadow).toBeUndefined(); expect(fakeAi.calls).toHaveLength(0);
});

it("refuses a forged signature and a signed cross-tenant eligibility attempt", async () => {
  const s = setup();
  const forged = await mintToken("rogue", { tenant: "tenant_synthetic", claims: { hm_governance: s.context } });
  expect((await direct("/v1/evaluations", call("POST", forged, s.req), { ...s.env, HM_GOVERNANCE: JSON.stringify(s.c) })).status).toBe(401);
  const other = await mintToken("educateos", { tenant: "other", claims: { hm_governance: s.context } });
  expect((await direct("/v1/evaluations", call("POST", other, s.req), { ...s.env, HM_GOVERNANCE: JSON.stringify(s.c) })).status).toBe(403);
  expect(fakeAi.calls).toHaveLength(0);
});

it("denies an unapproved escalation without inventing a billed attempt or changing provider", async () => {
  const s = setup(); s.c.tenants.tenant_synthetic!.route.modelIds = ["@cf/cloudflare/clef-flash"];
  const calls: string[] = [];
  s.env.AI = { async run(model) {
    calls.push(model);
    return { answers: Object.fromEntries(CLEF_QUESTIONS.map((q) => [q.id, { type: "noul", noul: q.id === "violence" ? 0.5 : 0.01 }])), usage: { input_tokens: 40 } };
  } };
  const response = await post(s); const result = EvaluationResult.parse(await response.json());
  expect(calls).toEqual(["@cf/cloudflare/clef-flash"]);
  expect(result.receipt?.attempts).toHaveLength(1); expect(result.uncertain).toBe(true);
});

it("invalid config denies transfers and reports a failed readiness check", async () => {
  const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { AI: fakeAi, HM_GOVERNANCE: "{}" });
  expect(EvaluationResult.parse(await response.json()).decision).toBe("hold"); expect(fakeAi.calls).toHaveLength(0);
  const ready = await direct("/v1/ready", call("GET", await mintToken("educateos")), { AI: fakeAi, HM_GOVERNANCE: "{}" });
  expect(ready.status).toBe(503); expect(await ready.json()).toMatchObject({ checks: { governanceConfig: false } });
});
