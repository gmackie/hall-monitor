import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, grant, ROOT } from "./helpers.ts";
import { fakeEvaluator, record } from "./fake-evaluator.ts";

beforeEach(() => {
  fakeEvaluator.reset();
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

describe("roles and tenant scoping", () => {
  it("lists only the viewer's tenants and refuses other tenants with 403", async () => {
    await grant("viewer@example.test", "playtrek", "viewer");
    const me = await (await api("viewer@example.test", "GET", "/me")).json();
    expect(me).toMatchObject({ isAdmin: false, tenants: ["playtrek"] });
    expect((await api("viewer@example.test", "GET", "/tenants/playtrek/evaluations")).status).toBe(200);
    expect((await api("viewer@example.test", "GET", "/tenants/playtrek-beta/evaluations")).status).toBe(403);
    expect((await api("viewer@example.test", "GET", "/tenants/playtrek-beta/profiles")).status).toBe(403);
    expect((await api("nobody@example.test", "GET", "/tenants/playtrek/evaluations")).status).toBe(403);
    expect((await api("viewer@example.test", "GET", "/roles")).status).toBe(403);
    expect((await api("viewer@example.test", "GET", "/audit")).status).toBe(403);
  });

  it("gives the admin HM_ADMIN_TENANTS plus every tenant named in a grant", async () => {
    await grant("someone@example.test", "educateos-district-7", "labeler");
    const me = await (await api(ROOT, "GET", "/me")).json() as { tenants: string[] };
    expect(me.tenants).toEqual(["playtrek", "playtrek-beta", "educateos-district-7"]);
  });

  it("grants and revokes roles with audit rows", async () => {
    expect((await api(ROOT, "POST", "/roles", { email: "Ed@Example.test", tenant: "playtrek", role: "policy-editor" })).status).toBe(201);
    expect((await api(ROOT, "POST", "/roles", { email: "ed@example.test", tenant: "playtrek", role: "admin" })).status).toBe(400);
    expect((await api(ROOT, "POST", "/roles", { email: "ed@example.test", tenant: "*", role: "viewer" })).status).toBe(400);
    const roles = await (await api(ROOT, "GET", "/roles")).json() as { roles: { email: string }[] };
    expect(roles.roles.map((r) => r.email)).toContain("ed@example.test");
    expect((await api(ROOT, "POST", "/roles:revoke", { email: "ed@example.test", tenant: "playtrek", role: "policy-editor" })).status).toBe(200);
    const audit = await (await api(ROOT, "GET", "/audit")).json() as { entries: { action: string; actor: string }[] };
    expect(audit.entries.map((e) => e.action)).toEqual(["role.revoked", "role.granted"]);
    expect(audit.entries.every((e) => e.actor === ROOT)).toBe(true);
  });

  it("a global admin grant in D1 works like the bootstrap list", async () => {
    await grant("second@example.test", "*", "admin");
    expect((await api("second@example.test", "GET", "/roles")).status).toBe(200);
  });
});

describe("evaluation explorer", () => {
  it("lists through AdminRpc with the parsed query and rejects bad parameters", async () => {
    fakeEvaluator.add(record("playtrek", "eval_a", "hold"));
    fakeEvaluator.add(record("playtrek", "eval_b"));
    const page = await (await api(ROOT, "GET", "/tenants/playtrek/evaluations?limit=1")).json() as { items: unknown[] };
    expect(page.items).toHaveLength(1);
    const bad = await api(ROOT, "GET", "/tenants/playtrek/evaluations?limit=0&secret=x");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: "invalid_request", message: "invalid query parameters: (unknown), limit" });
    expect((await api(ROOT, "GET", "/tenants/playtrek/evaluations?cursor=bad")).status).toBe(400);
  });

  it("reads one record in a tenant, and another tenant's id is 404", async () => {
    fakeEvaluator.add(record("playtrek", "eval_a", "block"));
    const ok = await api(ROOT, "GET", "/tenants/playtrek/evaluations/eval_a");
    expect(await ok.json()).toMatchObject({ tenant: "playtrek", record: { mode: "shadow", result: { decision: "allow", shadow: { decision: "block" } } } });
    expect((await api(ROOT, "GET", "/tenants/playtrek-beta/evaluations/eval_a")).status).toBe(404);
  });
});

describe("deep link GET /evaluations/{id}", () => {
  it("finds the record in whichever viewable tenant holds it, querying every tenant in parallel", async () => {
    fakeEvaluator.add(record("playtrek-beta", "eval_beta"));
    const response = await api(ROOT, "GET", "/evaluations/eval_beta");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: "playtrek-beta", record: { evaluationId: "eval_beta" } });
    expect(fakeEvaluator.calls.map((c) => c.tenant).sort()).toEqual(["playtrek", "playtrek-beta"]);
  });

  it("goes straight to ?tenant=", async () => {
    fakeEvaluator.add(record("playtrek", "eval_pt", "hold"));
    const response = await api(ROOT, "GET", "/evaluations/eval_pt?tenant=playtrek");
    expect(await response.json()).toMatchObject({ tenant: "playtrek" });
    expect(fakeEvaluator.calls).toEqual([{ method: "get", tenant: "playtrek" }]);
  });

  it("never reveals tenants the person cannot view", async () => {
    await grant("viewer@example.test", "playtrek", "viewer");
    fakeEvaluator.add(record("playtrek-beta", "eval_hidden"));
    const missing = await api("viewer@example.test", "GET", "/evaluations/eval_hidden");
    const named = await api("viewer@example.test", "GET", "/evaluations/eval_hidden?tenant=playtrek-beta");
    const unknown = await api("viewer@example.test", "GET", "/evaluations/eval_none?tenant=no-such-tenant");
    for (const response of [missing, named, unknown]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "not_found", message: "evaluation not found" });
    }
    expect(fakeEvaluator.calls.every((c) => c.tenant === "playtrek")).toBe(true);
  });
});

describe("profiles, models and reason codes", () => {
  it("shows every floor with no published overlay", async () => {
    const body = await (await api(ROOT, "GET", "/tenants/playtrek/profiles")).json() as { profiles: { id: string; published: unknown }[] };
    expect(body.profiles.map((p) => p.id)).toEqual(["educator", "published-content", "student-6-8", "student-9-12"]);
    expect(body.profiles.every((p) => p.published === null)).toBe(true);
    expect((await api(ROOT, "GET", "/tenants/playtrek/profiles/nope/revisions")).status).toBe(404);
  });

  it("lists models with rates and the reason-code catalog", async () => {
    const models = await (await api("viewer@example.test", "GET", "/models")).json() as { models: { modelId: string; status: string; rates: unknown[] }[] };
    expect(models.models.find((m) => m.modelId === "@cf/cloudflare/clairic")).toMatchObject({ status: "preview" });
    expect(models.models.every((m) => m.rates.length > 0)).toBe(true);
    const codes = await (await api("viewer@example.test", "GET", "/reason-codes")).json() as { codes: unknown[] };
    expect(codes.codes.length).toBeGreaterThan(0);
  });
});

it("keeps D1 tenant-scoped: no table holds content columns", async () => {
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('audit_log')").all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(["id", "at", "actor", "action", "tenant", "target_type", "target_id"]);
});
