import { env, SELF } from "cloudflare:test";

const BASE = "https://hall-monitor-admin.test";

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints an RS256 Access token with the run's private key; `claims` override the defaults. */
export async function accessToken(email: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwk = JSON.parse(env.TEST_ACCESS_KEY) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify({ iss: "https://hm-test.cloudflareaccess.com", aud: ["test-aud"], email, iat: now, exp: now + 600, ...claims }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

export const ROOT = "root@example.test";

/** Calls the admin API as `email` (a fresh token each call). */
export async function api(email: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (email !== null) headers["cf-access-jwt-assertion"] = await accessToken(email);
  if (body !== undefined) headers["content-type"] = "application/json";
  return SELF.fetch(`${BASE}/admin/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Grants a role directly in D1 (setup, not under test). */
export async function grant(email: string, tenant: string, role: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO roles (email, tenant, role, granted_by, granted_at) VALUES (?1, ?2, ?3, 'setup', '2026-01-01T00:00:00Z')")
    .bind(email, tenant, role).run();
}
