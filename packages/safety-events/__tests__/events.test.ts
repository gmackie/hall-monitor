import { describe, expect, it } from "vitest";
import { admitSafetyDelivery, deriveSafetyReference, parseSafetyEvent, safetyEventDigest, signSafetyDelivery,
  type SafetyEvent, type SafetyProducerGrant } from "../src/index.ts";

const now = Date.parse("2026-10-29T12:00:00Z"), scope = { tenantId: "synthetic_tenant", caseId: "synthetic_case" };
const key = new Uint8Array(32).fill(17);
async function event(): Promise<SafetyEvent> {
  const actor = await deriveSafetyReference(key, scope, "person", "actor_1"), target = await deriveSafetyReference(key, scope, "person", "target_1");
  return { schemaVersion: "1.0", mode: "synthetic", scope, producerId: "synthetic-source", recordId: "permission_1", version: 1,
    previousDigest: null, revisionKind: "initial", dependencies: [], occurredAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), category: "observed",
    assertion: { kind: "permission.transition", actor, target, group: await deriveSafetyReference(key, scope, "group", "group_1"),
      evidence: await deriveSafetyReference(key, scope, "evidence", "transaction_1"), purpose: "required-group-work",
      authority: { actorRole: "delegated-student-moderator", actorEnrollmentVerified: true, targetEnrollmentVerified: true, permissionVerified: true },
      from: "member", to: "removed" } };
}
const grant = (): SafetyProducerGrant => ({ scope, producerId: "synthetic-source", keyId: "key_1", key, categories: ["observed"],
  validFrom: now - 60000, expiresAt: now + 60000, maxEventAgeMs: 60000, maxLifetimeMs: 120000, revoked: false });

describe("synthetic restricted contracts", () => {
  it("keys references by tenant, case and kind without storing source identifiers", async () => {
    const a = await deriveSafetyReference(key, scope, "person", "source-secret");
    expect(a).toEqual(await deriveSafetyReference(key, scope, "person", "source-secret"));
    for (const other of [await deriveSafetyReference(key, { ...scope, tenantId: "other" }, "person", "source-secret"),
      await deriveSafetyReference(key, { ...scope, caseId: "other" }, "person", "source-secret"), await deriveSafetyReference(key, scope, "group", "source-secret")]) expect(a.token).not.toBe(other.token);
    expect(JSON.stringify(a)).not.toContain("source-secret");
    await expect(deriveSafetyReference(new Uint8Array(8), scope, "person", "source-secret")).rejects.toThrow("invalid safety key");
  });

  it("requires source authority/transition evidence and refuses personal preference or body fields", async () => {
    const original = await event();
    expect(parseSafetyEvent(original)).toBeDefined();
    const variants = [
      { ...original, mode: "production" }, { ...original, body: "SENTINEL" },
      { ...original, assertion: { ...original.assertion, kind: "personal.mute" } },
      { ...original, assertion: { ...original.assertion, to: "member" } },
      { ...original, assertion: { ...original.assertion, authority: { actorRole: "student", actorEnrollmentVerified: false } } },
      { ...original, assertion: { ...original.assertion, purpose: "invented" } },
      { ...original, assertion: { ...original.assertion, target: await deriveSafetyReference(key, { ...scope, tenantId: "other" }, "person", "target") } },
    ];
    for (const variant of variants) expect(parseSafetyEvent(variant)).toBeUndefined();
  });

  it("authenticates exact bytes and grants but never turns a report into an observed fact", async () => {
    const original = await event(), signed = await signSafetyDelivery(original, "key_1", key, now);
    expect((await admitSafetyDelivery(signed, grant(), now))?.digest).toBe(await safetyEventDigest(original));
    expect(await admitSafetyDelivery({ ...signed, body: signed.body + " " }, grant(), now)).toBeUndefined();
    expect(await admitSafetyDelivery({ ...signed, sentAt: now + 1 }, grant(), now)).toBeUndefined();
    expect(await admitSafetyDelivery({ ...signed, mac: "0".repeat(64) }, grant(), now)).toBeUndefined();
    const reportGrant = { ...grant(), categories: ["reported" as const] };
    expect(await admitSafetyDelivery(signed, reportGrant, now)).toBeUndefined();
    const allegation = { ...original, category: "reported", assertion: original.assertion };
    await expect(signSafetyDelivery(allegation, "key_1", key, now)).rejects.toThrow("invalid safety delivery");
  });

  it("rejects wrong scope/key/producer, expired/revoked grants and stale/future evidence", async () => {
    const original = await event(), signed = await signSafetyDelivery(original, "key_1", key, now);
    for (const g of [{ ...grant(), scope: { ...scope, caseId: "other" } }, { ...grant(), keyId: "other" }, { ...grant(), key: new Uint8Array(32).fill(2) },
      { ...grant(), producerId: "other" }, { ...grant(), revoked: true }, { ...grant(), expiresAt: now }, { ...grant(), maxEventAgeMs: 10 },
      { ...grant(), maxLifetimeMs: 10 }]) expect(await admitSafetyDelivery(signed, g, now)).toBeUndefined();
    for (const changed of [{ ...original, occurredAt: new Date(now + 1).toISOString() }, { ...original, expiresAt: new Date(now).toISOString() }]) {
      expect(await admitSafetyDelivery(await signSafetyDelivery(changed, "key_1", key, now), grant(), now)).toBeUndefined();
    }
    const freshSignature = await signSafetyDelivery(original, "key_1", key, now + 300001);
    expect(await admitSafetyDelivery(freshSignature, grant(), now)).toBeUndefined();
  });
});
