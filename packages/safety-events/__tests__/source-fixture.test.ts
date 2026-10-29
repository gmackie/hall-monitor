import { describe, expect, it } from "vitest";
import { deriveSafetyReference, safetyEventDigest, signSafetyDelivery, type SafetyEvent } from "../src/index.ts";

/** An in-memory source transaction fixture. This is not a source product or durable outbox. */
function sourceFixture() {
  const key = new Uint8Array(32).fill(31), scope = { tenantId: "synthetic_tenant", caseId: "synthetic_case" };
  const now = Date.parse("2026-10-29T12:00:00Z");
  const state = { role: "delegated-student-moderator", permission: true, actorEnrolled: true, targetEnrolled: true,
    purpose: "required-group-work", member: true, version: 0, head: null as string | null, outbox: [] as SafetyEvent[] };
  async function action(kind: "remove" | "restore" | "personal-mute", failCommit = false) {
    if (kind === "personal-mute") return;
    if (!state.permission || !state.actorEnrolled || !state.targetEnrolled || !["staff", "delegated-student-moderator"].includes(state.role)) throw new Error("source permission denied");
    const member = kind === "restore";
    if (member === state.member) return;
    const expectedVersion = state.version;
    const ref = (type: "person" | "group" | "evidence", raw: string) => deriveSafetyReference(key, scope, type, raw);
    const event: SafetyEvent = { schemaVersion: "1.0", mode: "synthetic", scope, producerId: "source-fixture", recordId: "required-access-1",
      version: state.version + 1, previousDigest: state.head, revisionKind: state.version === 0 ? "initial" : "transition", dependencies: [],
      occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), category: "observed",
      assertion: { kind: "permission.transition", actor: await ref("person", "source-actor"), target: await ref("person", "source-target"),
        group: await ref("group", "source-group"), evidence: await ref("evidence", `transaction-${state.version + 1}`),
        purpose: state.purpose as "required-group-work", authority: { actorRole: state.role as "delegated-student-moderator",
          actorEnrollmentVerified: true, targetEnrollmentVerified: true, permissionVerified: true },
        from: state.member ? "member" : "removed", to: member ? "member" : "removed" } };
    const digest = await safetyEventDigest(event);
    if (state.version !== expectedVersion) throw new Error("source transaction raced");
    const before = { ...state, outbox: [...state.outbox] };
    try {
      state.member = member; state.version++; state.head = digest; state.outbox.push(event);
      if (failCommit) throw new Error("source commit failed");
    } catch (e) { Object.assign(state, before); throw e; }
  }
  return { state, action, dispatch: async () => Promise.all(state.outbox.map((event) => signSafetyDelivery(event, "fixture-key", key, now))) };
}

describe("source-owned transaction fixture", () => {
  it("emits only committed permission changes and retries with stable event identity", async () => {
    const source = sourceFixture();
    await expect(source.action("remove", true)).rejects.toThrow("commit failed");
    expect(source.state.member).toBe(true); expect(source.state.version).toBe(0); expect(await source.dispatch()).toEqual([]);
    await source.action("remove"); await source.action("remove");
    expect(source.state.outbox).toHaveLength(1); expect(source.state.member).toBe(false);
    expect(await source.dispatch()).toEqual(await source.dispatch());
    await source.action("restore");
    expect(source.state.outbox[1]!.previousDigest).toBe(await safetyEventDigest(source.state.outbox[0]!));
    expect(source.state.member).toBe(true);
  });

  it("rejects untrusted authority/enrollment and never emits personal mute preferences", async () => {
    for (const denied of [{ role: "student" }, { permission: false }, { actorEnrolled: false }, { targetEnrolled: false }]) {
      const source = sourceFixture(); Object.assign(source.state, denied);
      await expect(source.action("remove")).rejects.toThrow("permission denied"); expect(source.state.outbox).toEqual([]);
    }
    const source = sourceFixture(); await source.action("personal-mute"); expect(source.state.outbox).toEqual([]);
  });
});
