import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import { freezeSafetyValue, parseSafetyEvent, SafetyReference, SafetyScope, type SafetyEvent } from "./events.ts";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function keyFor(key: Uint8Array) {
  if (key.byteLength < 32 || key.byteLength > 128) throw new Error("invalid safety key");
  return crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Keyed refs change across tenant, case and entity type. Raw source identifiers never enter an event. */
export async function deriveSafetyReference(key: Uint8Array, scope: SafetyScope, kind: SafetyReference["kind"], sourceRef: string): Promise<SafetyReference> {
  const parsed = SafetyScope.safeParse(scope);
  if (!parsed.success || !z.enum(["person", "group", "evidence", "evidence-group"]).safeParse(kind).success || sourceRef.length < 1 || sourceRef.length > 2048) throw new Error("invalid safety reference");
  const token = hex(await crypto.subtle.sign("HMAC", await keyFor(key), encoder.encode(`hall-monitor/synthetic-safety-ref/v1\n${canonical([parsed.data.tenantId, parsed.data.caseId, kind, sourceRef])}`)));
  return freezeSafetyValue({ ...parsed.data, kind, token });
}
export async function safetyEventDigest(input: unknown): Promise<string> {
  const event = parseSafetyEvent(input);
  if (event === undefined) throw new Error("invalid safety event");
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", encoder.encode(`hall-monitor/synthetic-safety-record/v1\n${canonical(event)}`)))}`;
}

const Delivery = z.strictObject({ keyId: OpaqueId, sentAt: z.number().int().safe().nonnegative(), body: z.string().max(16_384), mac: z.string().regex(/^[a-f0-9]{64}$/) });
export type SafetyDelivery = z.infer<typeof Delivery>;
export interface SafetyProducerGrant {
  readonly scope: SafetyScope; readonly producerId: string; readonly keyId: string; readonly key: Uint8Array;
  readonly categories: readonly SafetyEvent["category"][];
  readonly validFrom: number; readonly expiresAt: number; readonly maxEventAgeMs: number; readonly maxLifetimeMs: number; readonly revoked: boolean;
}
const Grant = z.strictObject({ scope: SafetyScope, producerId: OpaqueId, keyId: OpaqueId,
  key: z.instanceof(Uint8Array).refine((k) => k.byteLength >= 32 && k.byteLength <= 128),
  categories: z.array(z.enum(["observed", "reported", "model"])).min(1).max(3),
  validFrom: z.number().int().safe().nonnegative(), expiresAt: z.number().int().safe().nonnegative(),
  maxEventAgeMs: z.number().int().safe().positive(), maxLifetimeMs: z.number().int().safe().positive(), revoked: z.boolean(),
}).refine((g) => g.expiresAt > g.validFrom && new Set(g.categories).size === g.categories.length);
const signedBytes = (d: Omit<SafetyDelivery, "mac">) => encoder.encode(`hall-monitor/synthetic-safety-delivery/v1\n${d.keyId}\n${d.sentAt}\n${d.body}`);

/** Fixture producer only. Real source commit/outbox and key custody belong to the source product. */
export async function signSafetyDelivery(input: unknown, keyId: string, key: Uint8Array, sentAt: number): Promise<SafetyDelivery> {
  const event = parseSafetyEvent(input);
  if (event === undefined || !OpaqueId.safeParse(keyId).success || !Number.isSafeInteger(sentAt) || sentAt < 0) throw new Error("invalid safety delivery");
  const payload = { keyId, sentAt, body: canonical(event) };
  if (encoder.encode(payload.body).byteLength > 16_384) throw new Error("invalid safety delivery");
  return { ...payload, mac: hex(await crypto.subtle.sign("HMAC", await keyFor(key), signedBytes(payload))) };
}

declare const verified: unique symbol;
export interface VerifiedSafetyEvent { readonly event: SafetyEvent; readonly digest: string; readonly receivedAt: number; readonly [verified]: true }
const admitted = new WeakSet<object>();
export function isVerifiedSafetyEvent(value: unknown): value is VerifiedSafetyEvent { return value !== null && typeof value === "object" && admitted.has(value); }

/** Authentication proves the enrolled producer's assertion, not independent platform truth. No route is installed. */
export async function admitSafetyDelivery(input: unknown, grantInput: SafetyProducerGrant, now: number): Promise<VerifiedSafetyEvent | undefined> {
  const parsed = Delivery.safeParse(input);
  const parsedGrant = Grant.safeParse(grantInput);
  if (!parsed.success || !parsedGrant.success || !Number.isSafeInteger(now) || now < 0) return undefined;
  const grant = parsedGrant.data;
  const d = parsed.data;
  if (encoder.encode(d.body).byteLength > 16_384 || d.keyId !== grant.keyId || grant.revoked ||
      ![grant.validFrom, grant.expiresAt, grant.maxEventAgeMs].every(Number.isSafeInteger) || grant.maxEventAgeMs <= 0 ||
      now < grant.validFrom || now >= grant.expiresAt || d.sentAt < grant.validFrom || d.sentAt >= grant.expiresAt || Math.abs(d.sentAt - now) > 300_000) return undefined;
  try {
    const mac = Uint8Array.from(d.mac.match(/../g)!, (b) => Number.parseInt(b, 16));
    if (!await crypto.subtle.verify("HMAC", await keyFor(grant.key), mac, signedBytes(d))) return undefined;
    const event = parseSafetyEvent(JSON.parse(d.body));
    if (event === undefined || event.scope.tenantId !== grant.scope.tenantId || event.scope.caseId !== grant.scope.caseId ||
        event.producerId !== grant.producerId || !grant.categories.includes(event.category) || Date.parse(event.occurredAt) < grant.validFrom || Date.parse(event.occurredAt) > now ||
        now - Date.parse(event.occurredAt) > grant.maxEventAgeMs || Date.parse(event.expiresAt) - Date.parse(event.occurredAt) > grant.maxLifetimeMs ||
        now >= Date.parse(event.expiresAt)) return undefined;
    const result = freezeSafetyValue({ event, digest: await safetyEventDigest(event), receivedAt: now }) as VerifiedSafetyEvent;
    admitted.add(result); return result;
  } catch { return undefined; }
}
