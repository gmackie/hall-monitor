// Synthetic W16 drill: actual evaluator -> transactional outbox -> signed transport -> actual
// receiver -> aggregate DO -> signed durable ack. Only AI, clocks and network failures are fake.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvaluationKind, type EvaluationRequest, type EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { signedDeliveryRequestV2 } from "@gmacko/hall-monitor-telemetry-sink";
import { handleTelemetry } from "../../telemetry-worker/src/index.ts";
import { controls } from "../../telemetry-worker/test/controls.ts";
import { configDoc, intervalDoc, policyDoc } from "../../telemetry-worker/test/fixtures.ts";
import { TelemetryAggregateStore as TestAggregate } from "../../telemetry-worker/test/entry.ts";
import { handle } from "../src/app.ts";
import type { Env } from "../src/env.ts";
import { IdempotencyStore as TestProducer } from "./entry.ts";
import { binding, probe, type Attempt } from "./collector.ts";
import { fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const TENANT = "tenant_educateos";
const KEY = "SYNTHETIC-RECONCILIATION-KEY-0123456789-abcdefgh";
const REVISION = "synthetic-drill-1";
const SOURCE_SENTINEL = "synthetic.source.18c7";
const producerGrants = JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: REVISION } });
const receiverGrants = JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevisions: [REVISION] } });
const producer = () => env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName(`tenant:${TENANT}`));
const aggregate = () => env.AGGREGATES!.get(env.AGGREGATES!.idFromName(`tenant:${TENANT}`));
type Outbox = { delivery_id: string; digest: string; payload: string; attempts: number; deadline_at: number };
const outbox = () => runInDurableObject(producer(), (_i, s) => s.storage.sql.exec<Outbox>("SELECT * FROM telemetry_outbox ORDER BY delivery_id").toArray());
const due = () => runInDurableObject(producer(), (_i, s) => { s.storage.sql.exec("UPDATE telemetry_outbox SET next_attempt_at = 0"); });
async function deliver() { await due(); expect(await runDurableObjectAlarm(producer())).toBe(true); }

function bindings(enabled = true): Env {
  return { ...env, AI: fakeAi, ...(enabled ? { HM_TELEMETRY_V2_ENABLED: "true" } : {}),
    HM_TELEMETRY_V2_TENANTS: producerGrants, HM_TELEMETRY_V2_RETENTION: probe.retention!, METRICS_COLLECTOR: binding } as Env;
}
function receiverConfig(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ [TENANT]: configDoc({ retention: policyDoc(),
    intervals: [intervalDoc({ producerRevisions: [REVISION] })], ...extra }) });
}
function receiver(config = receiverConfig()) {
  return { ...env, HM_TELEMETRY_V2_ACCEPT: "aggregate", HM_TELEMETRY_V2_TENANTS: receiverGrants, HM_TELEMETRY_V2_CONFIG: config };
}
const receive = (a: Attempt, config?: string) => handleTelemetry(a.rebuild(), receiver(config));
const post = async (row: Outbox, config?: string) => handleTelemetry(await signedDeliveryRequestV2(TENANT, KEY, row.payload, row.digest), receiver(config));
async function evaluate(request: EvaluationRequest, b = bindings()) {
  return handle(new Request("https://hall-monitor.test/v1/evaluations", call("POST", await mintToken("educateos"), request)), b);
}
async function totals() {
  const rows = await aggregate().rollups();
  return { evaluated: rows.reduce((n, r) => n + r.evaluated, 0), candidate: rows.reduce((n, r) => n + r.candidate, 0) };
}
async function dump(which: "producer" | "receiver") {
  const target = which === "producer" ? producer() : aggregate();
  return runInDurableObject(target, (_i, s) => {
    const names = s.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    return JSON.stringify(names.map(({ name }) => ({ name, rows: s.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray() })));
  });
}
async function restartBoth() {
  await runInDurableObject(producer(), async (_i, s) => {
    await s.storage.deleteAlarm(); new TestProducer(s, env);
    await s.blockConcurrencyWhile(async () => {});
    expect(await s.storage.getAlarm()).not.toBeNull();
  });
  await runInDurableObject(aggregate(), async (_i, s) => {
    const wasArmed = (await s.storage.getAlarm()) !== null;
    await s.storage.deleteAlarm(); new TestAggregate(s, env);
    await s.blockConcurrencyWhile(async () => {});
    expect((await s.storage.getAlarm()) !== null).toBe(wasArmed);
  });
  // Then discard the instances as well. The next RPC runs fresh constructors over kept storage.
  await runInDurableObject(producer(), (_i, s) => s.abort("synthetic reconciliation restart")).catch(() => {});
  await runInDurableObject(aggregate(), (_i, s) => s.abort("synthetic reconciliation restart")).catch(() => {});
}

beforeEach(() => {
  probe.reset(); controls.reset(); fakeAi.reset();
  probe.grants = producerGrants;
  probe.retention = JSON.stringify({ [TENANT]: policyDoc() });
});
afterEach(() => { probe.reset(); controls.reset(); fakeAi.reset(); vi.restoreAllMocks(); });

describe("synthetic reconciliation through both real durable stores", () => {
  // Independent product membership table: a new supported kind must be classified explicitly.
  const kinds = ["interaction.input", "interaction.output", "content.candidate", "assessment.evaluator-result"] as const;
  it("accounts for every supported evaluation kind in the product membership table", () => {
    expect([...kinds].sort()).toEqual([...EvaluationKind.options].sort());
  });

  it.each(kinds.flatMap((kind) => [false, true].map((degraded) => ({ kind, degraded }))))(
    "counts a unique $kind commit with degraded=$degraded once through the real receiver",
    async ({ kind, degraded }) => {
      const request = evaluationRequest({ kind, text: `${SENTINEL} ${HARASSMENT_MARKER}` });
      fakeAi.failing = degraded;
      const first = await evaluate(request);
      expect(first.status).toBe(200);
      const result = await first.json() as EvaluationResult;
      expect(result.degraded !== undefined).toBe(degraded);
      expect(await outbox()).toHaveLength(1);
      const replay = await evaluate(request);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect((await replay.json() as EvaluationResult).evaluationId).toBe(result.evaluationId);
      // A conflicting retry and a rejected evaluation never manufacture a committed unit.
      expect((await evaluate({ ...request, content: { type: "text", text: "changed" } })).status).toBe(409);
      expect((await evaluate(evaluationRequest({ kind, policy: { profileId: "missing", revision: "builtin-1" } }))).status).toBe(404);
      expect(await outbox()).toHaveLength(1);
      probe.handler = receive;
      await deliver();
      // Degraded holds belong in E; they are not evidence of a candidate F.
      expect(await totals()).toEqual({ evaluated: 1, candidate: degraded ? 0 : 1 });
      expect(await outbox()).toHaveLength(0);
      expect((await aggregate().health()).producerCoverage).toBe("unavailable");
    },
  );

  it("counts unique batch item commits, excluding an already committed item and a rejected item", async () => {
    const candidate = evaluationRequest({ kind: "content.candidate", text: HARASSMENT_MARKER });
    const assessment = evaluationRequest({ kind: "assessment.evaluator-result" });
    const missing = evaluationRequest({ kind: "content.candidate", policy: { profileId: "missing", revision: "builtin-1" } });
    expect((await evaluate(candidate)).status).toBe(200);
    const response = await handle(new Request("https://hall-monitor.test/v1/evaluations:batch",
      call("POST", await mintToken("educateos"), { requests: [candidate, assessment, missing] })), bindings());
    expect(response.status).toBe(200);
    const body = await response.json() as { items: { status: string; result?: EvaluationResult }[] };
    expect(body.items.map((i) => i.status)).toEqual(["ok", "ok", "error"]);
    expect(body.items[0]!.result!.requestId).toBe(candidate.requestId);
    expect(await outbox()).toHaveLength(2);
    probe.handler = receive;
    await deliver();
    expect(await totals()).toEqual({ evaluated: 2, candidate: 1 });
    expect((await aggregate().health()).producerCoverage).toBe("unavailable");
  });

  it("matches an independent completion ledger after outage, restart, reordered concurrent duplicates and lost acknowledgments", async () => {
    // Truth is fixed before evaluating or looking at transport/receiver records.
    const ledger = Object.freeze([
      { name: "benign", text: `${SENTINEL} Why are leaves green?`, candidate: false, decision: "allow", failing: false },
      { name: "candidate", text: `${SENTINEL} ${HARASSMENT_MARKER}`, candidate: true, decision: "hold", failing: false },
      { name: "degraded", text: `${SENTINEL} A classroom question`, candidate: false, decision: "hold", failing: true },
    ]);
    const requests = ledger.map((entry) => evaluationRequest({ text: entry.text,
      source: { product: "educateos", tenantId: TENANT, surface: SOURCE_SENTINEL } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [i, entry] of ledger.entries()) {
      fakeAi.failing = entry.failing;
      const response = await evaluate(requests[i]!);
      expect(response.status).toBe(200);
      expect((await response.json() as EvaluationResult).decision).toBe(entry.decision);
    }
    fakeAi.failing = false;
    const replay = await evaluate(requests[0]!);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const invalid = { ...evaluationRequest(), policy: { profileId: "missing", revision: "builtin-1" } };
    expect((await evaluate(invalid)).status).toBe(404);
    expect(await outbox()).toHaveLength(ledger.length);
    expect(probe.attempts).toHaveLength(0); // No response-path delivery.

    probe.handler = undefined; // First alarm: collector cannot be reached.
    await deliver();
    expect(await producer().telemetryState()).toMatchObject({ pending: 3, retrying: 3, gaps: [] });
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0 });
    const frozenRows = await outbox();
    await restartBoth();
    expect(await outbox()).toEqual(frozenRows);
    // Force the opposite delivery order without changing the frozen signed payload.
    await runInDurableObject(producer(), (_i, s) => {
      frozenRows.forEach((r, i) => s.storage.sql.exec("UPDATE telemetry_outbox SET next_attempt_at = ? WHERE delivery_id = ?", frozenRows.length - i, r.delivery_id));
    });
    // Receiver clock is after the original bucket: late receipt corrects occurrence time.
    controls.clockOffsetMs = 20 * 60 * 1000;
    probe.handler = async (a) => {
      const responses = await Promise.all([receive(a), receive(a)]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      return new Response(null, { status: 503 }); // Both transactions committed; both acks lost.
    };
    expect(await runDurableObjectAlarm(producer())).toBe(true);
    const expected = { evaluated: ledger.length, candidate: ledger.filter((e) => e.candidate).length };
    expect(await totals()).toEqual(expected);
    expect(await producer().telemetryState()).toMatchObject({ pending: 3, gaps: [] });
    expect(probe.attempts.slice(-3).map((a) => a.deliveryId)).toEqual(frozenRows.map((r) => r.delivery_id).reverse());
    const rows = await aggregate().rollups();
    expect(rows.reduce((n, r) => n + (r.lateRevisions ?? 0), 0)).toBe(3);
    expect(rows.every((r) => r.completeness === "unavailable")).toBe(true);
    expect((await aggregate().health()).producerCoverage).toBe("unavailable");

    await restartBoth();
    probe.handler = receive; // Real signed deduplicated acks finally reach the outbox.
    await deliver();
    expect(await outbox()).toHaveLength(0);
    expect(await totals()).toEqual(expected);
    expect(await producer().telemetryState()).toMatchObject({ pending: 0, gaps: [] });
    const attempts = probe.attempts;
    for (const r of frozenRows) {
      const same = attempts.filter((a) => a.deliveryId === r.delivery_id);
      expect(same).toHaveLength(3);
      expect(same.every((a) => a.body === r.payload && a.digest === r.digest)).toBe(true);
    }
    // Every payload must also pass the receiver route on replay without adding a unit.
    for (const r of frozenRows) expect((await post(r)).status).toBe(200);
    expect(await totals()).toEqual(expected);
    const logs = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
    const producerDump = await dump("producer"), receiverDump = await dump("receiver");
    expect(producerDump).not.toContain(SENTINEL);
    for (const forbidden of [SENTINEL, SOURCE_SENTINEL, ...requests.flatMap((r) => [r.requestId, r.idempotencyKey])]) {
      expect(frozenRows.map((r) => r.payload).join("\n")).not.toContain(forbidden);
      expect(receiverDump).not.toContain(forbidden);
      expect(logs).not.toContain(forbidden);
    }
    for (const r of frozenRows) expect(receiverDump).not.toContain(r.delivery_id);
  });

  it("accounts for queue capacity, expiry and withdrawal as durable gaps while moderation still succeeds", async () => {
    const ledger = Object.freeze([
      { outcome: "queued", text: "Why is the sky blue?" },
      { outcome: "capacity", text: HARASSMENT_MARKER },
    ]);
    const b = bindings();
    Object.assign(b, { HM_TELEMETRY_OUTBOX_MAX_ROWS: "1" });
    for (const entry of ledger) expect((await evaluate(evaluationRequest({ text: `${SENTINEL} ${entry.text}` }), b)).status).toBe(200);
    expect(await producer().telemetryState()).toMatchObject({ pending: 1, gaps: [{ reason: "capacity", lost: 1 }] });
    // Age the queued row's deadline, not its frozen occurrence/payload.
    await runInDurableObject(producer(), (_i, s) => { s.storage.sql.exec("UPDATE telemetry_outbox SET deadline_at = 0"); });
    await deliver();
    expect(await producer().telemetryState()).toMatchObject({ pending: 0 });
    let gaps = (await producer().telemetryState()).gaps;
    expect(gaps.reduce((n, g) => n + g.lost, 0)).toBe(ledger.length);
    expect(gaps.map((g) => g.reason).sort()).toEqual(["capacity", "expired"]);
    expect(probe.attempts).toHaveLength(0);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0 });

    expect((await evaluate(evaluationRequest({ text: SENTINEL }))).status).toBe(200);
    probe.grants = null; // Source withdrawal is checked before any network attempt.
    await deliver();
    gaps = (await producer().telemetryState()).gaps;
    expect(gaps.reduce((n, g) => n + g.lost, 0)).toBe(3);
    expect(gaps.find((g) => g.reason === "revoked")?.lost).toBe(1);
    expect(probe.attempts).toHaveLength(0);
    expect((await evaluate(evaluationRequest({ text: SENTINEL }), bindings(false))).status).toBe(200);
    expect(await outbox()).toHaveLength(0);
    expect((await producer().telemetryState()).gaps).toEqual(gaps);
    expect((await aggregate().health()).producerCoverage).toBe("unavailable");
  });

  it("cannot recount expired receiver totals by re-signing held deliveries", async () => {
    expect((await evaluate(evaluationRequest({ text: `${SENTINEL} ${HARASSMENT_MARKER}` }))).status).toBe(200);
    const held = (await outbox())[0]!;
    probe.handler = receive;
    await deliver();
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1 });
    // The receiver enforces retention at read time, before its alarm deletes anything.
    controls.clockOffsetMs = 32 * 24 * 60 * 60 * 1000;
    expect(await aggregate().rollups()).toEqual([]);
    expect((await aggregate().health()).producerCoverage).toBe("unavailable");
    expect((await post(held)).status).toBe(422);
    expect(await aggregate().rollups()).toEqual([]);
    expect(await runDurableObjectAlarm(aggregate())).toBe(true);
    expect((await dump("receiver"))).not.toContain(SENTINEL);
  });

  it("purges on authenticated receiver revocation and refuses a held row after re-enrollment without a durable ack", async () => {
    expect((await evaluate(evaluationRequest({ text: SENTINEL }))).status).toBe(200);
    const held = (await outbox())[0]!;
    probe.handler = async (a) => { expect((await receive(a)).status).toBe(200); return new Response(null, { status: 503 }); };
    await deliver();
    expect(await totals()).toEqual({ evaluated: 1, candidate: 0 });
    const revoked = receiverConfig({ state: "revoked", revocationRef: "SYNTHETIC-TEST-WITHDRAWAL" });
    expect((await post(held, revoked)).status).toBe(403);
    expect(await aggregate().rollups()).toEqual([]);
    expect((await post(held)).status).toBe(422);
    probe.handler = receive;
    await deliver();
    expect(await producer().telemetryState()).toMatchObject({ pending: 1, retrying: 1 });
    expect(await aggregate().rollups()).toEqual([]);
    expect((await aggregate().health()).producerCoverage).toBe("unavailable");
  });
});
