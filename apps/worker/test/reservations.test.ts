import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { buildTelemetryDeliveryV2, newDeliveryId } from "@gmacko/hall-monitor-telemetry-contracts";
import type { IdempotencyStore, TelemetryInput } from "../src/store.ts";
import { IdempotencyStore as TestStore } from "./entry.ts";
import { handle } from "../src/app.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, evaluationRequest } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const result: EvaluationResult = { schemaVersion: "1.0", evaluationId: "eval_reservation", requestId: "req_reservation",
  decision: "allow", reasonCodes: [], findings: [], uncertain: false, policyRevision: "builtin-1",
  evaluatorBundleRevision: "base-1.0.1", resolverVersion: "resolver-1.0.0", receipt: null };
const record = { schemaVersion: "1.0" as const, evaluationId: result.evaluationId, requestId: result.requestId,
  tenantId: "tenant_educateos", receipt: null, recordedAt: new Date().toISOString() };
const stub = () => env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName("tenant:tenant_educateos"));
const owner = async (store: IdempotencyStore | ReturnType<typeof stub>, digest = "digest") => {
  const b = await store.begin("key", digest);
  if (b.kind !== "started") throw new Error("expected reservation");
  return b.reservationId;
};
async function telemetry(): Promise<TelemetryInput> {
  const now = Date.now();
  const built = await buildTelemetryDeliveryV2({ deliveryId: newDeliveryId(), producerRevision: "synthetic-reservation-1",
    events: [{ schemaVersion: 1, occurredAt: new Date(now).toISOString(), kind: "content_evaluated", category: "none", priority: "routine",
      modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown" }] });
  return { kind: "delivery", deliveryId: built.delivery.deliveryId, payload: built.payload, digest: built.digest,
    occurredAtMs: now, retention: { gapMs: 86_400_000, approvedUntilMs: now + 86_400_000 },
    retryHorizonMs: 3_600_000, maxRows: 10, maxBytes: 100_000 };
}
afterEach(() => { vi.restoreAllMocks(); fakeAi.reset(); });

it("refuses completion without a reservation and writes no receipt", async () => {
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    expect(await store.completeReserved("missing", "digest", "nonexistent-owner", result, record)).toBeNull();
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
  });
});

it("refuses a mismatched reservation digest and writes no receipt", async () => {
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    const owner = await store.begin("key", "actual-digest");
    if (owner.kind !== "started") throw new Error("expected reservation");
    expect(await store.completeReserved("key", "other-digest", owner.reservationId, result, record)).toBeNull();
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
  });
});

it("refuses a second completion instead of writing another result and receipt", async () => {
  const firstTelemetry = await telemetry(), secondTelemetry = await telemetry();
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    const owner = await store.begin("key", "digest");
    if (owner.kind !== "started") throw new Error("expected reservation");
    await store.completeReserved("key", "digest", owner.reservationId, result, record, firstTelemetry);
    const queued = state.storage.sql.exec("SELECT * FROM telemetry_outbox").toArray();
    expect(queued).toHaveLength(1);
    const other = { ...result, evaluationId: "eval_duplicate" };
    expect(await store.completeReserved("key", "digest", owner.reservationId, other, { ...record, evaluationId: other.evaluationId }, secondTelemetry)).toBeNull();
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT * FROM telemetry_outbox").toArray()).toEqual(queued);
    expect(state.storage.sql.exec("SELECT * FROM telemetry_gaps").toArray()).toEqual([]);
    expect(await store.begin("key", "digest")).toEqual({ kind: "replay", result });
  });
});

it.each(["digest", "different-digest"])("only the replacement owner completes after expiry (replacement digest %s)", async (replacementDigest) => {
  const t = await telemetry();
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    const old = await owner(store);
    state.storage.sql.exec("UPDATE idempotency SET expires_at = 0");
    const current = await owner(store, replacementDigest);
    expect(current).not.toBe(old);
    expect(await store.completeReserved("key", "digest", old, result, record, t)).toBeNull();
    await store.abandonReserved("key", "digest", old);
    expect(await store.begin("key", replacementDigest)).toEqual({ kind: "in_progress" });
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
    expect(state.storage.sql.exec("SELECT * FROM telemetry_outbox").toArray()).toEqual([]);
    expect(await store.completeReserved("key", replacementDigest, current, result, record, t)).toMatchObject(record);
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT * FROM telemetry_outbox").toArray()).toHaveLength(1);
  });
});

it("refuses an expired owner even when no replacement has started", async () => {
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    const old = await owner(store);
    state.storage.sql.exec("UPDATE idempotency SET expires_at = 0");
    expect(await store.completeReserved("key", "digest", old, result, record)).toBeNull();
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
    expect(await owner(store)).not.toBe(old);
  });
});

it("keeps an owner over an object restart and consumes it with exactly one concurrent completion", async () => {
  const reservation = await owner(stub());
  await runInDurableObject(stub(), (_i, state) => state.abort("synthetic reservation restart")).catch(() => {});
  const results = await Promise.all([
    stub().completeReserved("key", "digest", reservation, result, record),
    stub().completeReserved("key", "digest", reservation, result, record),
  ]);
  expect(results.filter((r) => r !== null)).toHaveLength(1);
  expect(await stub().begin("key", "digest")).toEqual({ kind: "replay", result });
});

it("migrates old completed rows while refusing ownerless pending and older-call completion", async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    state.storage.sql.exec("DROP TABLE idempotency");
    state.storage.sql.exec("CREATE TABLE idempotency (key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, expires_at INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT INTO idempotency VALUES ('done', 'digest', 'done', ?, ?), ('pending', 'digest', 'pending', NULL, ?)", JSON.stringify(result), Date.now() + 60_000, Date.now() + 60_000);
    const migrated = new TestStore(state, env);
    await state.blockConcurrencyWhile(async () => {});
    expect(await migrated.begin("done", "digest")).toEqual({ kind: "replay", result });
    expect(await migrated.begin("pending", "digest")).toEqual({ kind: "in_progress" });
    expect(await migrated.completeReserved("pending", "digest", "invented-owner", result, record)).toBeNull();
    // A previous Worker revision uses the former RPC argument order; it must fail closed.
    await expect(migrated.complete("pending", "digest", result, record)).rejects.toThrow("reservation ownership is required");
    await migrated.abandon("pending", "digest");
    expect(await migrated.begin("pending", "digest")).toEqual({ kind: "in_progress" });
    expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
    state.storage.sql.exec("UPDATE idempotency SET expires_at = 0 WHERE key = 'pending'");
    const fresh = await migrated.begin("pending", "digest");
    expect(fresh).toMatchObject({ kind: "started", reservationId: expect.any(String) });
  });
});

it("returns a retryable conflict for late work while the replacement HTTP result replays", async () => {
  const request = evaluationRequest();
  const originalRun = fakeAi.run.bind(fakeAi);
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let count = 0;
  vi.spyOn(fakeAi, "run").mockImplementation(async (...args) => {
    if (++count === 1) { enter(); await held; }
    return originalRun(...args);
  });
  const post = async () => handle(new Request("https://hall-monitor.test/v1/evaluations", call("POST", await mintToken("educateos"), request)), { ...env, AI: fakeAi });
  const late = post();
  try {
    await entered;
    await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec("UPDATE idempotency SET expires_at = 0 WHERE key = ?", request.idempotencyKey); });
    const current = await post();
    expect(current.status).toBe(200);
    const currentResult = await current.json();
    release();
    const stale = await late;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "idempotency_conflict", retryable: true });
    const replay = await post();
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(currentResult);
    await runInDurableObject(stub(), (_i, state) => {
      expect(state.storage.sql.exec("SELECT * FROM receipts").toArray()).toHaveLength(1);
    });
  } finally { release(); await late; }
});

it("a stale owner cannot abandon a replacement reservation with the same request digest", async () => {
  await runInDurableObject(stub(), async (store: IdempotencyStore, state) => {
    const owner = await store.begin("key", "digest");
    if (owner.kind !== "started") throw new Error("expected reservation");
    state.storage.sql.exec("UPDATE idempotency SET expires_at = 0");
    const replacement = await store.begin("key", "digest");
    expect(replacement).toMatchObject({ kind: "started", reservationId: expect.any(String) });
    await store.abandonReserved("key", "digest", owner.reservationId);
    expect(await store.begin("key", "digest")).toEqual({ kind: "in_progress" });
  });
});
