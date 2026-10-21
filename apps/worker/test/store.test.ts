import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { describe, expect, it } from "vitest";
import type { IdempotencyStore } from "../src/store.ts";

const RESULT: EvaluationResult = {
  schemaVersion: "1.0",
  evaluationId: "eval_store_1",
  requestId: "req_store_1",
  decision: "allow",
  reasonCodes: [],
  findings: [],
  uncertain: false,
  policyRevision: "builtin-1",
  evaluatorBundleRevision: "base-1.0.0",
  resolverVersion: "resolver-1.0.0",
  receipt: null,
};

const record = { schemaVersion: "1.0", evaluationId: "eval_store_1", requestId: "req_store_1", tenantId: "tenant_store", receipt: null, recordedAt: "2026-10-21T00:00:00.000Z" };

describe("IdempotencyStore", () => {
  it("reserves, replays, conflicts and reports in-flight requests", async () => {
    const store = env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName("tenant:store-1"));
    expect(await store.begin("idem_1", "digest-a")).toEqual({ kind: "started" });
    expect(await store.begin("idem_1", "digest-a")).toEqual({ kind: "in_progress" });
    expect(await store.begin("idem_1", "digest-b")).toEqual({ kind: "conflict" });
    await store.complete("idem_1", "digest-a", RESULT, record);
    expect(await store.begin("idem_1", "digest-a")).toEqual({ kind: "replay", result: RESULT });
    expect(await store.receipt("eval_store_1")).toMatchObject({ ...record, expiresAt: expect.any(String) });
  });

  it("frees an abandoned reservation for a retry", async () => {
    const store = env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName("tenant:store-2"));
    await store.begin("idem_1", "digest-a");
    await store.abandon("idem_1", "digest-a");
    expect(await store.begin("idem_1", "digest-b")).toEqual({ kind: "started" });
  });

  it("ignores expired records and purges them on its alarm", async () => {
    const stub = env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName("tenant:store-3"));
    await stub.begin("idem_live", "digest-live");
    await stub.complete("idem_live", "digest-live", RESULT, record);
    await runInDurableObject(stub, async (_instance: IdempotencyStore, state) => {
      const past = Date.now() - 1;
      state.storage.sql.exec("UPDATE idempotency SET expires_at = ?", past);
      state.storage.sql.exec("UPDATE receipts SET expires_at = ?", past);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await stub.receipt("eval_store_1")).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance: IdempotencyStore, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM idempotency").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM receipts").one().n).toBe(0);
    });
    // A purged key is free again.
    expect(await stub.begin("idem_live", "digest-other")).toEqual({ kind: "started" });
  });
});
