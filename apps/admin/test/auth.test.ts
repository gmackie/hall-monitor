import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminApp } from "../src/app.ts";
import { accessToken, api, ROOT } from "./helpers.ts";

const BASE = "https://hall-monitor-admin.test/admin/v1";

beforeEach(() => {
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

async function withToken(token: string | null) {
  return SELF.fetch(`${BASE}/me`, token === null ? {} : { headers: { "cf-access-jwt-assertion": token } });
}

describe("Cloudflare Access authentication", () => {
  it("accepts a valid token and lowercases the email", async () => {
    const response = await api("Root@Example.test", "GET", "/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: ROOT, isAdmin: true, tenants: ["playtrek", "playtrek-beta"] });
  });

  it("refuses a missing token", async () => {
    expect((await withToken(null)).status).toBe(401);
  });

  it("refuses a bad signature", async () => {
    const token = await accessToken(ROOT);
    const [head, body] = token.split(".");
    const other = await accessToken("someone@example.test");
    expect((await withToken(`${head}.${body}.${other.split(".")[2]}`)).status).toBe(401);
  });

  it("refuses the wrong audience, issuer, expiry, algorithm, key and missing email", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      await accessToken(ROOT, { aud: ["other-aud"] }),
      await accessToken(ROOT, { iss: "https://evil.cloudflareaccess.com" }),
      await accessToken(ROOT, { exp: now - 120 }),
      await accessToken(ROOT, { nbf: now + 600 }),
      await accessToken(ROOT, {}, { alg: "HS256" }),
      await accessToken(ROOT, {}, { kid: "unknown" }),
      await accessToken(ROOT, { email: undefined }),
      "not.a.token",
    ]) {
      const response = await withToken(token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "unauthorized", message: "a valid Cloudflare Access session is required" });
    }
  });

  it("fails closed with 503 when Access is not configured", async () => {
    const app = createAdminApp({ jwks: async () => [] });
    const response = await app(new Request(`${BASE}/me`, { headers: { "cf-access-jwt-assertion": await accessToken(ROOT) } }), { DB: {} as D1Database });
    expect(response.status).toBe(503);
  });

  it("serves the SPA outside /admin/v1 without the API", async () => {
    const app = createAdminApp({ jwks: async () => [] });
    const assets = { fetch: async (request: Request) => new Response(`spa ${new URL(request.url).pathname}`) } as unknown as Fetcher;
    const response = await app(new Request("https://hall-monitor-admin.test/evaluations/eval_1"), { DB: {} as D1Database, ASSETS: assets });
    expect(await response.text()).toBe("spa /evaluations/eval_1");
  });

  it("answers unknown API routes with 404 and wrong methods with 405", async () => {
    expect((await api(ROOT, "GET", "/nope")).status).toBe(404);
    expect((await api(ROOT, "POST", "/me")).status).toBe(405);
  });
});
