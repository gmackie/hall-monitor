import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import { SyntheticReportingQuery, type SyntheticReportingResponse } from "./contracts.ts";
import { projectSyntheticRelease } from "./privacy.ts";
import type { SyntheticReleaseCatalog } from "./releases.ts";

const Claims = z.strictObject({ schemaVersion: z.literal("1.0"), mode: z.literal("synthetic"), issuer: OpaqueId,
  audience: z.literal("hall-monitor-synthetic-analytics"), tenantId: OpaqueId, subject: OpaqueId,
  role: z.literal("district-operator"), scope: z.literal("analytics:read"), nonce: OpaqueId,
  notBefore: z.number().int().safe().nonnegative(), expiresAt: z.number().int().safe().nonnegative(),
}).refine((c) => c.expiresAt > c.notBefore && c.expiresAt - c.notBefore <= 300_000);
export type SyntheticReaderClaims = z.infer<typeof Claims>;
const Token = z.strictObject({ claims: Claims, mac: z.string().regex(/^[a-f0-9]{64}$/) });
const bytes = (c: SyntheticReaderClaims) => new TextEncoder().encode(`hall-monitor/synthetic-analytics-reader/v1\n${JSON.stringify([
  c.schemaVersion, c.mode, c.issuer, c.audience, c.tenantId, c.subject, c.role, c.scope, c.nonce, c.notBefore, c.expiresAt])}`);
async function importKey(key: Uint8Array) {
  if (key.byteLength < 32 || key.byteLength > 128) throw new Error("invalid synthetic reader key");
  return crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/** Fixture issuer only. A real reader requires an identity provider and durable anti-replay store. */
export async function signSyntheticReaderToken(input: unknown, key: Uint8Array): Promise<z.infer<typeof Token>> {
  const c = Claims.safeParse(input); if (!c.success) throw new Error("invalid synthetic reader claims");
  const mac = await crypto.subtle.sign("HMAC", await importKey(key), bytes(c.data));
  return { claims: c.data, mac: Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("") };
}
export type SyntheticReadResult = { readonly status: 200; readonly body: SyntheticReportingResponse } |
  { readonly status: 400 | 401 | 404 | 503; readonly code: "invalid-query" | "unauthorized" | "not-found" | "unavailable" };

/** Offline service fixture: no HTTP endpoint, live reader grant or storage binding is added. */
export async function createSyntheticReportingReader(key: Uint8Array, issuer: string) {
  const imported = await importKey(key);
  if (!OpaqueId.safeParse(issuer).success) throw new Error("invalid synthetic reader issuer");
  const consumed = new Set<string>();
  let terminal = false;
  return Object.freeze({
    async read(token: unknown, query: unknown, catalog: SyntheticReleaseCatalog, now: number): Promise<SyntheticReadResult> {
      const parsed = Token.safeParse(token);
      if (!parsed.success || !Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) return { status: 401, code: "unauthorized" };
      const c = parsed.data.claims;
      if (c.issuer !== issuer || now < c.notBefore || now >= c.expiresAt) return { status: 401, code: "unauthorized" };
      const mac = Uint8Array.from(parsed.data.mac.match(/../g)!, (b) => Number.parseInt(b, 16));
      if (!await crypto.subtle.verify("HMAC", imported, mac, bytes(c))) return { status: 401, code: "unauthorized" };
      const nonce = JSON.stringify([c.issuer, c.tenantId, c.nonce]);
      if (consumed.has(nonce)) return { status: 401, code: "unauthorized" };
      if (terminal || consumed.size >= 1024) { terminal = true; return { status: 503, code: "unavailable" }; }
      consumed.add(nonce);
      const q = SyntheticReportingQuery.safeParse(query);
      if (!q.success) return { status: 400, code: "invalid-query" };
      if (catalog.status !== "open") return { status: 503, code: "unavailable" };
      const r = catalog.releases.find((r) => r.releaseId === q.data.releaseId && r.tenantId === c.tenantId);
      if (r === undefined) return { status: 404, code: "not-found" };
      return { status: 200, body: projectSyntheticRelease(r, now) };
    },
  });
}
