import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { verifyDeliveryRequestV2 } from "@gmacko/hall-monitor-telemetry-sink";
import { parseTelemetryDeliveryV2, sha256Hex } from "@gmacko/hall-monitor-telemetry-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { handle } from "../src/app.ts";
import { prepareTelemetryDelivery } from "../src/metrics.ts";
import type { IdempotencyStore } from "../src/store.ts";
import type { Env } from "../src/env.ts";
import { IdempotencyStore as TestStore } from "./entry.ts";
import { ack, binding, probe, type Attempt } from "./collector.ts";
import { fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const KEY = "synthetic-v2-outbox-signing-key-0123456789-abcdef";
const TENANT = "tenant_educateos";
const GRANTS = JSON.stringify({
  [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "rev-2026-10-a" },
});

function bindings(extra: Partial<Env> = {}): Env {
  return {
    ...env, AI: fakeAi,
    HM_TELEMETRY_V2_ENABLED: "true",
    HM_TELEMETRY_V2_TENANTS: GRANTS,
    METRICS_COLLECTOR: binding,
    ...extra,
  } as Env;
}

async function evaluate(b: Env, request = evaluationRequest()) {
  return handle(new Request("https://hall-monitor.test/v1/evaluations", call("POST", await mintToken("educateos"), request)), b);
}

const stub = () => env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName(`tenant:${TENANT}`));

async function rows<T>(sql: string, ...args: (string | number)[]): Promise<T[]> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(sql, ...args).toArray() as T[]);
}

const outboxRows = () => rows<{ delivery_id: string; payload: string; attempts: number; next_attempt_at: number; deadline_at: number }>("SELECT * FROM telemetry_outbox ORDER BY occurred_at");
const makeDue = () => runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec("UPDATE telemetry_outbox SET next_attempt_at = 0"); });
const alarmNow = () => runDurableObjectAlarm(stub());
const state = () => stub().telemetryState();

/** Everything the object stores, as one string, for leakage checks. */
async function dump(tables: string[]): Promise<string> {
  const all = await Promise.all(tables.map((t) => rows(`SELECT * FROM ${t}`)));
  return JSON.stringify(all);
}

beforeEach(() => {
  fakeAi.reset();
  probe.reset();
  probe.grants = GRANTS;
  vi.restoreAllMocks();
});
afterEach(() => probe.reset());

describe("W6 transactional telemetry outbox", () => {
  it("queues the content-free pair with the result and delivers nothing on the response path", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const request = evaluationRequest({ text: SENTINEL + " " + HARASSMENT_MARKER });
    const response = await evaluate(bindings(), request);
    expect(response.status).toBe(200);
    expect(probe.attempts).toHaveLength(0);

    const [row] = await outboxRows();
    expect(row).toBeDefined();
    const delivery = parseTelemetryDeliveryV2(JSON.parse(row!.payload));
    expect(delivery.events.map((e) => e.kind)).toEqual(["content_evaluated", "candidate_flagged"]);
    expect(delivery.producerRevision).toBe("rev-2026-10-a");
    // The pair shares one frozen occurrence time, and it is the stored one.
    expect(delivery.events[0]!.occurredAt).toBe(delivery.events[1]!.occurredAt);

    const body = await response.json() as { evaluationId: string };
    for (const secret of [SENTINEL, request.requestId, request.idempotencyKey, request.context.costCenterId, body.evaluationId, TENANT]) {
      expect(row!.payload).not.toContain(secret);
    }
    // No analytic dimension is the delivery ID, and no sentinel is stored anywhere in the object.
    expect(await dump(["idempotency", "receipts", "telemetry_outbox", "telemetry_gaps"])).not.toContain(SENTINEL);
    expect(await state()).toMatchObject({ pending: 1, retrying: 0, gaps: [] });
  });

  it("is off by default: no outbox row without the separate v2 opt-in, and v1 settings do not enable it", async () => {
    for (const extra of [
      { HM_TELEMETRY_V2_ENABLED: undefined },
      { HM_TELEMETRY_V2_TENANTS: undefined },
      { METRICS_COLLECTOR: undefined },
      { HM_TELEMETRY_V2_TENANTS: JSON.stringify({ tenant_other: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "r1" } }) },
      { HM_TELEMETRY_V2_TENANTS: JSON.stringify({ [TENANT]: { source: "playtrek", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "r1" } }) },
      // v1 enrolment alone (even complete) never creates v2 state.
      { HM_TELEMETRY_V2_ENABLED: undefined, HM_TELEMETRY_ENABLED: "true", HM_TELEMETRY_TENANTS: JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } }) },
    ] as Partial<Env>[]) {
      const b = bindings();
      Object.assign(b, extra);
      expect((await evaluate(b)).status).toBe(200);
    }
    expect(await outboxRows()).toHaveLength(0);
    expect(await state()).toMatchObject({ pending: 0, gaps: [] });
  });

  it("rolls the whole completion back when the commit fails, leaving no outbox row", async () => {
    const request = evaluationRequest();
    const result: EvaluationResult = {
      schemaVersion: "1.0", evaluationId: "eval_atomic_1", requestId: request.requestId, decision: "allow",
      reasonCodes: [], findings: [], uncertain: false, policyRevision: "builtin-1",
      evaluatorBundleRevision: "base-1.0.0", resolverVersion: "resolver-1.0.0", receipt: null,
    };
    const record = { schemaVersion: "1.0" as const, evaluationId: result.evaluationId, requestId: result.requestId, tenantId: TENANT, receipt: null, recordedAt: new Date().toISOString() };
    const telemetry = await prepareTelemetryDelivery(bindings(), TENANT, request, result);
    expect(telemetry?.kind).toBe("delivery");

    // Called on the object itself so the injected exception stays inside the test: an exception
    // crossing the RPC boundary makes the runner's storage teardown fail, which is unrelated.
    await runInDurableObject(stub(), async (store: IdempotencyStore) => {
      expect(await store.begin("idem_atomic", "digest-a")).toEqual({ kind: "started" });
      probe.failCompletion = true;
      // Every write (result, receipt, outbox row) ran before the injected failure.
      await expect(store.complete("idem_atomic", "digest-a", result, record, telemetry!)).rejects.toThrow("injected commit failure");
    });
    expect(await outboxRows()).toHaveLength(0);
    expect(await rows("SELECT * FROM receipts")).toHaveLength(0);
    expect(await rows("SELECT * FROM idempotency WHERE state = 'done'")).toHaveLength(0);
    expect(await rows("SELECT * FROM telemetry_gaps")).toHaveLength(0);

    // The same completion, once the fault is gone, commits all three together.
    probe.failCompletion = false;
    await runInDurableObject(stub(), (store: IdempotencyStore) => store.complete("idem_atomic", "digest-a", result, record, telemetry!));
    expect(await outboxRows()).toHaveLength(1);
    expect(await rows("SELECT * FROM receipts")).toHaveLength(1);
    expect(await rows("SELECT * FROM idempotency WHERE state = 'done'")).toHaveLength(1);
  });

  it("adds nothing on an idempotent replay or a failed evaluation", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const request = evaluationRequest();
    expect((await evaluate(bindings(), request)).status).toBe(200);
    const replay = await evaluate(bindings(), request);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const unknownPolicy = { ...evaluationRequest(), policy: { profileId: "missing", revision: "builtin-1" } };
    expect((await evaluate(bindings(), unknownPolicy)).status).toBe(404);
    expect(await outboxRows()).toHaveLength(1);
    expect(await state()).toMatchObject({ pending: 1, gaps: [] });
  });

  it("keeps moderation decisions identical whether v2 is off, queued or its collector is down", async () => {
    const marked = () => evaluationRequest({ text: SENTINEL + " " + HARASSMENT_MARKER });
    const decide = async (b: Env) => {
      const body = await (await evaluate(b, marked())).json() as { decision: string; findings: { category: string }[]; reasonCodes: string[] };
      return { decision: body.decision, findings: body.findings.map((f) => f.category), reasonCodes: body.reasonCodes };
    };
    const disabled = bindings();
    delete (disabled as { HM_TELEMETRY_V2_ENABLED?: string }).HM_TELEMETRY_V2_ENABLED;
    const off = await decide(disabled);
    probe.handler = async (a) => ack(a, KEY);
    expect(await decide(bindings())).toEqual(off);
    probe.handler = undefined;
    expect(await decide(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" }))).toEqual(off);
  });

  it("survives a restart: the committed row is rearmed on wake and delivered by the alarm", async () => {
    probe.handler = async (a) => ack(a, KEY);
    await evaluate(bindings());
    // Crash between commit and alarm: the row is durable but the alarm is gone. A new object over
    // the same storage is what a restart produces; constructing it must re-arm the alarm.
    await runInDurableObject(stub(), async (_i, st) => {
      await st.storage.deleteAlarm();
      expect(await st.storage.getAlarm()).toBeNull();
      new TestStore(st, env);
      await st.blockConcurrencyWhile(async () => {});
      expect(await st.storage.getAlarm()).not.toBeNull();
    });
    expect(await state()).toMatchObject({ pending: 1 });
    await makeDue();
    expect(await alarmNow()).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
    expect(probe.attempts).toHaveLength(1);
  });

  it("delivers by itself after the commit, with no help from the response path", async () => {
    probe.firstAttemptDelayMs = 0;
    probe.handler = async (a) => ack(a, KEY);
    await evaluate(bindings());
    await vi.waitFor(async () => { expect(await outboxRows()).toHaveLength(0); }, { timeout: 5000 });
    expect(probe.attempts).toHaveLength(1);
  });

  it("delivers a v2-signed envelope after commit and clears the row only on a verified ack", async () => {
    probe.handler = async (a) => ack(a, KEY);
    await evaluate(bindings());
    const [row] = await outboxRows();
    await makeDue();
    expect(await alarmNow()).toBe(true);
    const [attempt] = probe.attempts as [Attempt];
    expect(attempt.path).toBe("/internal/v2/telemetry");
    expect(attempt.deliveryId).toBe(row!.delivery_id);
    expect(attempt.digest).toBe(await sha256Hex(row!.payload));
    // The request authenticates under the v2 domain with the tenant key.
    const verified = await verifyDeliveryRequestV2(attempt.rebuild(), KEY);
    expect(verified.tenant).toBe(TENANT);
    expect(verified.digest).toBe(attempt.digest);
    expect(await outboxRows()).toHaveLength(0);
    expect(await state()).toMatchObject({ pending: 0, gaps: [] });
  });

  it("backs off after a timeout and a rejection, then resends the same ID and digest freshly signed", async () => {
    await evaluate(bindings());
    const [row] = await outboxRows();
    probe.timeoutMs = 40;
    await makeDue();

    // Timeout: the collector never answers.
    probe.handler = () => new Promise<Response>(() => {});
    await alarmNow();
    expect(probe.attempts).toHaveLength(1);
    let [after] = await outboxRows();
    expect(after!.attempts).toBe(1);
    expect(after!.next_attempt_at).toBeGreaterThan(Date.now() + 20_000);

    // Not due yet: another alarm does not hit the network.
    await alarmNow();
    expect(probe.attempts).toHaveLength(1);

    // Rejection.
    await makeDue();
    probe.handler = async () => new Response("no", { status: 403 });
    await alarmNow();
    expect(probe.attempts).toHaveLength(2);
    [after] = await outboxRows();
    expect(after!.attempts).toBe(2);
    // Backoff grows (30 s, then 60 s) and stays bounded by the retry horizon.
    expect(after!.next_attempt_at - Date.now()).toBeGreaterThan(40_000);
    expect(after!.next_attempt_at).toBeLessThan(after!.deadline_at);

    // Lost ack: the receiver committed, but its answer never arrived; the retry is deduplicated.
    await makeDue();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    probe.handler = async (a) => ack(a, KEY, "deduplicated");
    await alarmNow();
    expect(await outboxRows()).toHaveLength(0);

    const ids = new Set(probe.attempts.map((a) => a.deliveryId));
    const digests = new Set(probe.attempts.map((a) => a.digest));
    const bodies = new Set(probe.attempts.map((a) => a.body));
    expect([...ids]).toEqual([row!.delivery_id]);
    expect(digests.size).toBe(1);
    expect(bodies.size).toBe(1);
    expect(probe.attempts[2]!.timestamp).not.toBe(probe.attempts[0]!.timestamp);
    expect(probe.attempts[2]!.signature).not.toBe(probe.attempts[0]!.signature);
  });

  it("never clears on T1's 202 persisted:false or on an invalid, mismatched or forged ack", async () => {
    probe.handler = async (a) => ack(a, KEY);
    await evaluate(bindings());
    const good = async (a: Attempt) => (await (await ack(a, KEY)).json()) as Record<string, unknown>;
    const wrong = [
      async () => new Response(JSON.stringify({ code: "validated_not_persisted", accepted: 1, persisted: false }), { status: 202 }),
      async () => new Response(JSON.stringify({ code: "validated_not_persisted", accepted: 1, persisted: false }), { status: 200 }),
      async () => new Response(null, { status: 200 }),
      async () => new Response("not json", { status: 200 }),
      async (a: Attempt) => Response.json({ ...await good(a), persisted: false }),
      async (a: Attempt) => Response.json({ ...await good(a), status: "accepted" }),
      async (a: Attempt) => Response.json({ ...await good(a), extra: true }),
      async (a: Attempt) => Response.json({ ...await good(a), deliveryId: "dlv_" + "0".repeat(32) }),
      async (a: Attempt) => Response.json({ ...await good(a), digest: "0".repeat(64) }),
      async (a: Attempt) => Response.json({ ...await good(a), mac: "0".repeat(64) }),
      async (a: Attempt) => ack(a, "another-tenants-signing-key-0123456789-abcdef"),
      async (a: Attempt) => Response.json({ ...await good(a), schemaVersion: 1 }),
    ];
    for (const handler of wrong) {
      probe.handler = handler;
      await makeDue();
      await alarmNow();
      expect(await outboxRows()).toHaveLength(1);
    }
    expect(probe.attempts).toHaveLength(wrong.length);
    // Only a genuine ack for this ID and digest clears it.
    probe.handler = async (a) => ack(a, KEY);
    await makeDue();
    await alarmNow();
    expect(await outboxRows()).toHaveLength(0);
  });

  it("clears only the acknowledged deliveries when a batch partly fails", async () => {
    await evaluate(bindings());
    await evaluate(bindings());
    await evaluate(bindings());
    const queued = await outboxRows();
    expect(queued).toHaveLength(3);
    const failing = queued[1]!.delivery_id;
    probe.handler = async (a) => (a.deliveryId === failing ? new Response(null, { status: 503 }) : ack(a, KEY));
    await makeDue();
    await alarmNow();
    expect(probe.attempts).toHaveLength(3);
    const left = await outboxRows();
    expect(left.map((r) => r.delivery_id)).toEqual([failing]);
    expect(left[0]!.attempts).toBe(1);
    expect(await state()).toMatchObject({ pending: 1, retrying: 1 });
  });

  it("records a durable coverage gap, not a silent drop, when the outbox is full", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const limited = bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "2" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await evaluate(limited)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    const s = await state();
    expect(s.pending).toBe(2);
    // One bounded row per (UTC hour, reason): the count grows, the table does not.
    expect(s.gaps.reduce((n, g) => n + g.lost, 0)).toBe(4);
    expect(s.gaps.every((g) => g.reason === "capacity")).toBe(true);
    expect((await rows("SELECT * FROM telemetry_gaps")).length).toBeLessThanOrEqual(2);

    // The byte bound works the same way.
    const bytes = bindings({ HM_TELEMETRY_OUTBOX_MAX_BYTES: "10" });
    expect((await evaluate(bytes)).status).toBe(200);
    expect((await state()).pending).toBe(2);
    expect((await state()).gaps.reduce((n, g) => n + g.lost, 0)).toBe(5);
  });

  it("expires a delivery past its retry horizon as a counted gap and stops sending", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    await evaluate(bindings());
    await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec("UPDATE telemetry_outbox SET deadline_at = ?", Date.now() - 1); });
    await makeDue();
    await alarmNow();
    expect(probe.attempts).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await state()).toMatchObject({ pending: 0, gaps: [{ reason: "expired", lost: 1 }] });
  });

  it("enforces disable and revocation on retry, dropping the row as a revoked gap", async () => {
    const revocations: (string | null)[] = [
      null, // v2 disabled
      JSON.stringify({ tenant_other: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "r1" } }),
      JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g6_8"], signingKey: KEY, producerRevision: "rev-2026-10-a" } }),
      JSON.stringify({ [TENANT]: { source: "playtrek", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "rev-2026-10-a" } }),
    ];
    for (const grants of revocations) {
      probe.reset();
      probe.grants = GRANTS;
      probe.handler = async () => new Response(null, { status: 503 });
      await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec("DELETE FROM telemetry_gaps"); });
      await evaluate(bindings());
      await makeDue();
      await alarmNow(); // first attempt fails and backs off
      const before = probe.attempts.length;
      probe.grants = grants;
      await makeDue();
      await alarmNow();
      expect(probe.attempts).toHaveLength(before);
      expect((await state()).gaps).toEqual([expect.objectContaining({ reason: "revoked", lost: 1 })]);
      await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec("DELETE FROM telemetry_outbox"); });
    }
  });

  it("drops a delivery the receiver reports as a digest conflict, as a counted gap", async () => {
    probe.handler = async () => new Response(JSON.stringify({ code: "digest_conflict" }), { status: 409 });
    await evaluate(bindings());
    await makeDue();
    await alarmNow();
    expect(await outboxRows()).toHaveLength(0);
    expect(await state()).toMatchObject({ gaps: [{ reason: "conflict", lost: 1 }] });
  });

  it("shares one alarm between cleanup and delivery without postponing either", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    await evaluate(bindings());
    await makeDue();
    await runInDurableObject(stub(), async (_i, state) => {
      // Cleanup is ~24 h away and the delivery is due: the single alarm must serve the earliest.
      state.storage.sql.exec("UPDATE telemetry_outbox SET next_attempt_at = ?", Date.now() - 1000);
      await state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      // An expired receipt sits alongside the pending delivery.
      state.storage.sql.exec("UPDATE receipts SET expires_at = ?", Date.now() - 1);
      state.storage.sql.exec("UPDATE idempotency SET expires_at = ?", Date.now() - 1);
    });
    await alarmNow();
    expect(await rows("SELECT * FROM receipts")).toHaveLength(0);
    expect(await rows("SELECT * FROM idempotency")).toHaveLength(0);
    expect(probe.attempts).toHaveLength(1);
    // Rearmed for the retry (~30 s), not for the next cleanup.
    await runInDurableObject(stub(), async (_i, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm! - Date.now()).toBeLessThan(60_000);
      expect(alarm! - Date.now()).toBeGreaterThan(10_000);
    });
  });

  it("logs only fixed codes, never content, identifiers, delivery IDs or keys", async () => {
    const logs: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
    probe.handler = async () => { throw new Error(SENTINEL + KEY); };
    const request = evaluationRequest({ text: SENTINEL });
    await evaluate(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" }), request);
    await evaluate(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" }));
    const [row] = await outboxRows();
    await makeDue();
    await alarmNow();
    const text = logs.join("\n");
    expect(text).toContain("telemetry.delivery_failed");
    expect(text).toContain("telemetry.coverage_gap");
    for (const secret of [SENTINEL, KEY, row!.delivery_id, row!.payload, request.idempotencyKey]) {
      expect(text).not.toContain(secret);
    }
    // The gap and outbox tables hold no request, student or source identifier.
    const stored = await dump(["telemetry_gaps"]) + (await outboxRows()).map((r) => r.payload).join();
    for (const id of [request.requestId, request.idempotencyKey, SENTINEL, request.context.costCenterId]) {
      expect(stored).not.toContain(id);
    }
  });
});
