import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { verifyDeliveryRequestV2 } from "@gmacko/hall-monitor-telemetry-sink";
import { parseTelemetryDeliveryV2, sha256Hex } from "@gmacko/hall-monitor-telemetry-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { handle } from "../src/app.ts";
import { prepareTelemetryDelivery } from "../src/metrics.ts";
import { OUTBOX_WITHDRAW_BATCH_PER_ALARM, type IdempotencyStore } from "../src/store.ts";
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
// FICTIONAL retention policy: the reference is not an approval and the durations are not approved.
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const policy = (over: Record<string, unknown> = {}) => ({
  policyRevision: "synthetic-policy-1",
  approvalRef: "SYNTHETIC-TEST-ONLY-NOT-AN-APPROVAL",
  effectiveFrom: iso(Date.now() - 30 * DAY),
  approvedUntil: iso(Date.now() + 400 * DAY),
  dedupeSeconds: 87_300, rollupSeconds: 87_300, healthSeconds: 3_600, gapSeconds: 30 * 86_400,
  ...over,
});
const retentionFor = (over: Record<string, unknown> = {}) => JSON.stringify({ [TENANT]: policy(over) });
const RETENTION = retentionFor();

function bindings(extra: Partial<Env> = {}): Env {
  return {
    ...env, AI: fakeAi,
    HM_TELEMETRY_V2_ENABLED: "true",
    HM_TELEMETRY_V2_TENANTS: GRANTS,
    HM_TELEMETRY_V2_RETENTION: RETENTION,
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
  probe.retention = RETENTION;
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

  // One test per case, not one loop: each evaluation is a full Worker + Durable Object round trip, so
  // a single test running them all in sequence had a duration proportional to the case count and hit
  // the 5 s limit on a slow runner (canonical CI run 28: 14 evaluations, summed latency 3.5 s). Every
  // case keeps its own isolated storage and asserts the same two things the loop asserted at its end.
  const OFF_BY_DEFAULT: readonly (readonly [string, Record<string, string | undefined>])[] = [
    ["v2 not enabled", { HM_TELEMETRY_V2_ENABLED: undefined }],
    ["no v2 grants", { HM_TELEMETRY_V2_TENANTS: undefined }],
    ["no collector binding", { METRICS_COLLECTOR: undefined }],
    // No valid retention policy in force: nothing is collected, and no gap is invented either.
    ["no retention setting", { HM_TELEMETRY_V2_RETENTION: undefined }],
    ["unparseable retention", { HM_TELEMETRY_V2_RETENTION: "{" }],
    ["empty retention", { HM_TELEMETRY_V2_RETENTION: "{}" }],
    ["retention for another tenant", { HM_TELEMETRY_V2_RETENTION: JSON.stringify({ tenant_other: policy() }) }],
    ["retention approval expired", { HM_TELEMETRY_V2_RETENTION: retentionFor({ effectiveFrom: iso(Date.now() - 3 * DAY), approvedUntil: iso(Date.now() - 1000) }) }],
    ["retention approval not yet effective", { HM_TELEMETRY_V2_RETENTION: retentionFor({ effectiveFrom: iso(Date.now() + DAY), approvedUntil: iso(Date.now() + 2 * DAY) }) }],
    ["gap retention below the accepted horizon", { HM_TELEMETRY_V2_RETENTION: retentionFor({ gapSeconds: 60 }) }],
    ["retention with an unknown field", { HM_TELEMETRY_V2_RETENTION: retentionFor({ extra: true }) }],
    // The v1 enablement and grants are not a retention policy.
    ["v1 enrolment without a retention setting", { HM_TELEMETRY_V2_RETENTION: undefined, HM_TELEMETRY_ENABLED: "true", HM_TELEMETRY_TENANTS: JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } }) }],
    ["grants for another tenant", { HM_TELEMETRY_V2_TENANTS: JSON.stringify({ tenant_other: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "r1" } }) }],
    ["grant for another source", { HM_TELEMETRY_V2_TENANTS: JSON.stringify({ [TENANT]: { source: "playtrek", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "r1" } }) }],
    // v1 enrolment alone (even complete) never creates v2 state.
    ["v1 enrolment alone", { HM_TELEMETRY_V2_ENABLED: undefined, HM_TELEMETRY_ENABLED: "true", HM_TELEMETRY_TENANTS: JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } }) }],
  ];

  it.each(OFF_BY_DEFAULT)("is off by default: no outbox row and no gap with %s", async (_name, extra) => {
    const b = bindings();
    Object.assign(b, extra);
    expect((await evaluate(b)).status).toBe(200);
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
    const reservation = await stub().begin("idem_atomic", "digest-a");
    expect(reservation).toMatchObject({ kind: "started", reservationId: expect.any(String) });
    if (reservation.kind !== "started") throw new Error("expected reservation");
    await runInDurableObject(stub(), async (store: IdempotencyStore) => {
      probe.failCompletion = true;
      // Every write (result, receipt, outbox row) ran before the injected failure.
      await expect(store.completeReserved("idem_atomic", "digest-a", reservation.reservationId, result, record, telemetry!)).rejects.toThrow("injected commit failure");
    });
    expect(await outboxRows()).toHaveLength(0);
    expect(await rows("SELECT * FROM receipts")).toHaveLength(0);
    expect(await rows("SELECT * FROM idempotency WHERE state = 'done'")).toHaveLength(0);
    expect(await rows("SELECT * FROM telemetry_gaps")).toHaveLength(0);

    // The same completion, once the fault is gone, commits all three together.
    probe.failCompletion = false;
    await runInDurableObject(stub(), (store: IdempotencyStore) => store.completeReserved("idem_atomic", "digest-a", reservation.reservationId, result, record, telemetry!));
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
    // An invalid or missing retention policy disables collection only; moderation is unchanged.
    expect(await decide(bindings({ HM_TELEMETRY_V2_RETENTION: "{" }))).toEqual(off);
    expect(await decide(bindings({ HM_TELEMETRY_V2_RETENTION: undefined } as never))).toEqual(off);
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
      probe.retention = RETENTION;
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

describe("W8a producer retention policy", () => {
  const stored = () => rows<{ hour_start: number; reason: string; lost: number; expires_at: number }>("SELECT * FROM telemetry_gaps ORDER BY hour_start, reason");
  const HOUR = 60 * 60 * 1000;

  it("keeps gap evidence for exactly the approved period, rounded up to the hour it names", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const b = bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1", HM_TELEMETRY_V2_RETENTION: retentionFor({ gapSeconds: 3 * 86_400 }) });
    const before = Date.now();
    await evaluate(b);
    await evaluate(b); // outbox full: capacity gap
    const [gap] = await stored();
    expect(gap).toMatchObject({ reason: "capacity", lost: 1 });
    // Expiry = end of the occurrence's UTC hour + 3 days; nothing finer than the hour it already names.
    const hourEnd = Math.floor(before / HOUR) * HOUR + HOUR;
    expect([hourEnd + 3 * 86_400_000, hourEnd + 3 * 86_400_000 + HOUR]).toContain(gap!.expires_at);
    expect(gap!.expires_at % HOUR).toBe(0);
    expect(await state()).toMatchObject({ pending: 1, gaps: [{ reason: "capacity", lost: 1 }] });
  });

  it("applies a shortened policy to evidence already held, and never lengthens it when a policy is extended", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const limited = (gapSeconds: number) => bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1", HM_TELEMETRY_V2_RETENTION: retentionFor({ gapSeconds }) });
    await evaluate(limited(30 * 86_400));
    await evaluate(limited(30 * 86_400)); // one capacity gap for the current hour
    const old = Date.now() - 20 * 86_400_000;
    const oldHour = Math.floor(old / HOUR) * HOUR;
    await runInDurableObject(stub(), (_i, st) => {
      // Older evidence written under the earlier, longer policy: expires 30 days after its hour.
      st.storage.sql.exec("INSERT INTO telemetry_gaps (hour_start, reason, lost, expires_at) VALUES (?, 'expired', 3, ?)", oldHour, oldHour + HOUR + 30 * 86_400_000);
    });
    expect(await stored()).toHaveLength(2);
    // The shorter policy (about 24 h) takes effect on the next contact and removes what it no longer permits.
    await evaluate(limited(87_300));
    expect((await stored()).map((g) => g.reason)).toEqual(["capacity"]);
    // Extending the policy later does not bring anything back, nor lengthen what remains.
    const remaining = (await stored())[0]!.expires_at;
    probe.retention = retentionFor({ gapSeconds: 90 * 86_400 });
    await evaluate(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1", HM_TELEMETRY_V2_RETENTION: retentionFor({ gapSeconds: 90 * 86_400 }) }));
    const [gap] = await stored();
    expect(gap!.reason).toBe("capacity");
    expect(gap!.expires_at).toBe(remaining);
  });

  it("drops queued rows without a network attempt once the policy expires or is revoked, leaving bounded gap evidence", async () => {
    const lapsed = retentionFor({ effectiveFrom: iso(Date.now() - 3 * DAY), approvedUntil: iso(Date.now() - 1000) });
    for (const later of [null, "{", lapsed, JSON.stringify({ tenant_other: policy() }), retentionFor({ gapSeconds: 1 })]) {
      probe.reset();
      probe.grants = GRANTS;
      probe.retention = RETENTION;
      probe.handler = async (a) => ack(a, KEY);
      await runInDurableObject(stub(), (_i, st) => { st.storage.sql.exec("DELETE FROM telemetry_gaps; DELETE FROM telemetry_outbox"); });
      await evaluate(bindings());
      expect(await outboxRows()).toHaveLength(1);
      probe.retention = later;
      await makeDue();
      await alarmNow();
      // Nothing was sent: delivery needs a policy in force, not merely a grant.
      expect(probe.attempts, String(later).slice(0, 30)).toHaveLength(0);
      expect(await outboxRows()).toHaveLength(0);
      // The loss is still visible (coverage unavailable, not complete), kept no longer than the last
      // admitted policy allowed.
      expect(await state()).toMatchObject({ pending: 0, gaps: [{ reason: "revoked", lost: 1 }] });
      const [gap] = await stored();
      expect(gap!.expires_at).toBeLessThanOrEqual(Math.ceil((gap!.hour_start + HOUR + 30 * 86_400_000) / HOUR) * HOUR);
    }
  });

  it("expires gap evidence at its stored time: excluded from reads first, deleted by the alarm, and the alarm goes idle", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    await evaluate(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" }));
    await evaluate(bindings({ HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" })); // capacity gap
    expect((await state()).gaps).toHaveLength(1);
    await runInDurableObject(stub(), (_i, st) => {
      // Drain the queue and let the gap's approved retention run out.
      const past = Date.now() - 1;
      st.storage.sql.exec("DELETE FROM telemetry_outbox");
      for (const table of ["telemetry_gaps", "idempotency", "receipts"]) st.storage.sql.exec(`UPDATE ${table} SET expires_at = ?`, past);
    });
    expect((await state()).gaps).toEqual([]); // read-time exclusion, before any alarm
    expect(await stored()).toHaveLength(1);
    await alarmNow();
    expect(await stored()).toHaveLength(0);
    await runInDurableObject(stub(), async (_i, st) => { expect(await st.storage.getAlarm()).toBeNull(); });
  });

  describe("when the approval has ended with rows still queued", () => {
    const COUNT = "SELECT COUNT(*) AS n FROM telemetry_outbox";

    /**
     * Runs the object's real alarm with the stored approval already elapsed. The only seam used is a
     * spy on setAlarm that records the time asked for; it passes nothing through (an alarm armed for
     * the past would fire by itself and race the runner's storage teardown) and is always restored.
     */
    async function alarmAfterApprovalEnded(prepare: (sql: SqlStorage) => void) {
      return runInDurableObject(stub(), async (instance, st) => {
        await st.storage.deleteAlarm();
        st.storage.sql.exec("UPDATE telemetry_policy SET approved_until = ?", Date.now() - 1000);
        prepare(st.storage.sql);
        const planned: number[] = [];
        const spy = vi.spyOn(st.storage, "setAlarm").mockImplementation(async (at) => { planned.push(Number(at)); });
        try {
          await instance.alarm();
          return {
            queued: st.storage.sql.exec<{ n: number }>(COUNT).one().n,
            gapsLost: st.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(lost), 0) AS n FROM telemetry_gaps").one().n,
            planned,
            now: Date.now(),
          };
        } finally {
          spy.mockRestore();
        }
      });
    }

    it("finalizes a queued row that is not yet due, with no send and no alarm in the past", async () => {
      probe.handler = async (a) => ack(a, KEY);
      await evaluate(bindings({ HM_TELEMETRY_V2_RETENTION: retentionFor({ approvedUntil: iso(Date.now() + 60_000) }) }));
      probe.retention = retentionFor({ approvedUntil: iso(Date.now() - 1000), effectiveFrom: iso(Date.now() - 3 * DAY) });
      const result = await alarmAfterApprovalEnded((sql) => sql.exec("UPDATE telemetry_outbox SET next_attempt_at = ?", Date.now() + 60_000));
      expect(result.queued).toBe(0);
      expect(result.gapsLost).toBe(1);
      expect(result.planned.every((at) => at > result.now)).toBe(true);
      expect(probe.attempts).toHaveLength(0);
      expect(await state()).toMatchObject({ pending: 0, gaps: [{ reason: "revoked", lost: 1 }] });
    });

    it("drains a queue larger than one batch in bounded steps, once each, never re-arming for an elapsed end", async () => {
      probe.handler = async (a) => ack(a, KEY);
      await evaluate(bindings());
      probe.retention = retentionFor({ approvedUntil: iso(Date.now() - 1000), effectiveFrom: iso(Date.now() - 3 * DAY) });
      const total = OUTBOX_WITHDRAW_BATCH_PER_ALARM * 2 + 7;
      // Not due, and in two different UTC hours so each gap is counted against its own hour.
      const seeded = (sql: SqlStorage) => {
        const [first] = sql.exec<{ payload: string; digest: string; occurred_at: number }>("SELECT payload, digest, occurred_at FROM telemetry_outbox").toArray();
        for (let i = 1; i < total; i++) {
          sql.exec(
            "INSERT INTO telemetry_outbox (delivery_id, tenant, digest, payload, occurred_at, attempts, next_attempt_at, deadline_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            `dlv_seeded_${i}`, TENANT, first!.digest, first!.payload, first!.occurred_at - (i % 2) * 2 * 60 * 60 * 1000,
            Date.now() + 60_000 + i, Date.now() + 6 * 60 * 60 * 1000,
          );
        }
        sql.exec("UPDATE telemetry_outbox SET next_attempt_at = ? WHERE delivery_id NOT LIKE 'dlv_seeded_%'", Date.now() + 60_000);
      };
      const remaining: number[] = [];
      let lost = 0;
      let last = await alarmAfterApprovalEnded(seeded);
      for (let step = 0; step < 10; step++) {
        remaining.push(last.queued);
        lost = last.gapsLost;
        if (last.queued === 0) break;
        // More is queued, so the object asks to run again at once: that is the forward progress, and
        // it is never a time that stays in the past once the queue is empty.
        expect(last.planned).toHaveLength(1);
        last = await alarmAfterApprovalEnded(() => {});
      }
      expect(remaining).toEqual([total - OUTBOX_WITHDRAW_BATCH_PER_ALARM, total - 2 * OUTBOX_WITHDRAW_BATCH_PER_ALARM, 0]);
      expect(lost).toBe(total); // every row counted exactly once
      expect(probe.attempts).toHaveLength(0);
      expect(last.planned.every((at) => at > last.now)).toBe(true);
      const hours = await stored();
      expect(hours).toHaveLength(2);
      expect(hours.reduce((n, g) => n + g.lost, 0)).toBe(total);
    });

    it("after a restart, wakes at once for the ended approval, finalizes the row and then goes idle", async () => {
      probe.handler = async (a) => ack(a, KEY);
      await evaluate(bindings());
      probe.retention = retentionFor({ approvedUntil: iso(Date.now() - 1000), effectiveFrom: iso(Date.now() - 3 * DAY) });
      const outcome = await runInDurableObject(stub(), async (_i, st) => {
        st.storage.sql.exec("UPDATE telemetry_policy SET approved_until = ?", Date.now() - 1000);
        st.storage.sql.exec("UPDATE telemetry_outbox SET next_attempt_at = ?", Date.now() + 3_600_000);
        await st.storage.deleteAlarm();
        const planned: number[] = [];
        const spy = vi.spyOn(st.storage, "setAlarm").mockImplementation(async (at) => { planned.push(Number(at)); });
        try {
          // A restart is a new object over the same storage; its constructor decides the first wake.
          const restarted = new TestStore(st, env);
          await st.blockConcurrencyWhile(async () => {});
          const atRestart = [...planned];
          planned.length = 0;
          // The alarm the restart asked for is run by hand (the spy means it did not fire by itself).
          await restarted.alarm();
          return { atRestart, afterAlarm: planned, now: Date.now() };
        } finally {
          spy.mockRestore();
        }
      });
      // The retry time is an hour away, but the ended approval makes the queued row ineligible now.
      expect(outcome.atRestart).toHaveLength(1);
      expect(outcome.atRestart[0]!).toBeLessThanOrEqual(outcome.now);
      expect(await outboxRows()).toHaveLength(0);
      expect(await state()).toMatchObject({ pending: 0, gaps: [{ reason: "revoked", lost: 1 }] });
      expect(probe.attempts).toHaveLength(0);
      // Nothing queued and no elapsed end left to wake for: whatever is armed is future idle cleanup.
      expect(outcome.afterAlarm.every((at) => at > outcome.now)).toBe(true);
    });
  });

  it("wakes for the approval ending when rows are queued, not only for retries and cleanup", async () => {
    probe.handler = async () => new Response(null, { status: 503 });
    const soon = Date.now() + 60_000; // well before the 2-minute pending hold and the 6 h retry horizon
    await evaluate(bindings({ HM_TELEMETRY_V2_RETENTION: retentionFor({ approvedUntil: iso(soon) }) }));
    expect(await outboxRows()).toHaveLength(1);
    await runInDurableObject(stub(), async (_i, st) => {
      const armed = await st.storage.getAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeLessThanOrEqual(soon);
    });
  });

  it("treats a row queued before policies existed as unauthorized: no delivery, a counted gap with the legacy ceiling", async () => {
    probe.handler = async (a) => ack(a, KEY);
    await evaluate(bindings());
    await runInDurableObject(stub(), (_i, st) => { st.storage.sql.exec("DELETE FROM telemetry_policy"); });
    await makeDue();
    await alarmNow();
    expect(probe.attempts).toHaveLength(0);
    expect(await state()).toMatchObject({ pending: 0, gaps: [{ reason: "revoked", lost: 1 }] });
  });

  it("stores no tenant policy text or approval reference, and the policy table holds only a tenant, a duration and an end", async () => {
    await evaluate(bindings());
    const text = await dump(["telemetry_policy", "telemetry_gaps", "telemetry_outbox", "idempotency", "receipts"]);
    expect(text).not.toContain("SYNTHETIC-TEST-ONLY");
    expect(text).not.toContain("synthetic-policy");
    const [policyRow] = await rows<Record<string, unknown>>("SELECT * FROM telemetry_policy");
    expect(Object.keys(policyRow!).sort()).toEqual(["approved_until", "gap_ms", "id", "tenant"]);
  });
});
