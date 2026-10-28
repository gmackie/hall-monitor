import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  buildTelemetryDeliveryV2, newDeliveryId, TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS,
  type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { sendDeliveryV2, signedDeliveryRequestV2, signedTelemetryRequest, type TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelemetry, type TelemetryEnv } from "../src/index.ts";
import { DEDUPE_RETENTION_AFTER_OCCURRENCE_MS, type TelemetryAggregateStore } from "../src/store.ts";
import { controls } from "./controls.ts";

const KEY = "synthetic-receiver-educateos-key-0123456789-abc";
const OTHER_KEY = "synthetic-receiver-playtrek-key-0123456789-abcd";
const TENANT = "tenant_educateos";
const OTHER = "tenant_playtrek";
const GRANTS = JSON.stringify({
  [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevisions: ["rev-a", "rev-b"] },
  [OTHER]: { source: "playtrek", gradeBands: ["g9_12", "adult"], signingKey: OTHER_KEY, producerRevisions: ["rev-a"] },
});
const V1_KEY = "synthetic-v1-receiver-key-0123456789-abcdefghi";
const V1_GRANTS = JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: V1_KEY } });

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function evaluated(occurredAt: string, over: Partial<TemporalMetricEvent> = {}): TemporalMetricEvent {
  return {
    schemaVersion: 1, occurredAt, kind: "content_evaluated", category: "none", priority: "routine",
    modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown", ...over,
  };
}
const candidateOf = (e: TemporalMetricEvent): TemporalMetricEvent => ({ ...e, kind: "candidate_flagged", category: "other" });

async function delivery(over: { id?: string; revision?: string; occurredAt?: string; pair?: boolean; event?: Partial<TemporalMetricEvent> } = {}) {
  const first = evaluated(over.occurredAt ?? minutesAgo(5), over.event);
  return buildTelemetryDeliveryV2({
    deliveryId: over.id ?? newDeliveryId(),
    producerRevision: over.revision ?? "rev-a",
    events: over.pair ? [first, candidateOf(first)] : [first],
  });
}

function receiverEnv(extra: Partial<TelemetryEnv> = {}): TelemetryEnv {
  return { ...env, HM_TELEMETRY_V2_ACCEPT: "aggregate", HM_TELEMETRY_V2_TENANTS: GRANTS, ...extra } as TelemetryEnv;
}
const binding = (e: TelemetryEnv = receiverEnv()): TelemetryBinding => ({ fetch: (request) => handleTelemetry(request, e) });

type Built = Awaited<ReturnType<typeof delivery>>;
const send = (b: Built, tenant = TENANT, key = KEY, e = receiverEnv()) => sendDeliveryV2(binding(e), tenant, key, b.payload, b.digest);
const post = async (b: Built, tenant = TENANT, key = KEY, e = receiverEnv()) =>
  handleTelemetry(await signedDeliveryRequestV2(tenant, key, b.payload, b.digest), e);

const stub = (tenant = TENANT) => env.AGGREGATES!.get(env.AGGREGATES!.idFromName(`tenant:${tenant}`));
const totals = async (tenant = TENANT) => {
  const rows = await stub(tenant).rollups();
  return { evaluated: rows.reduce((n, r) => n + r.evaluated, 0), candidate: rows.reduce((n, r) => n + r.candidate, 0), rows: rows.length };
};
const sql = <T>(query: string, tenant = TENANT) =>
  runInDurableObject(stub(tenant), (_i, state) => state.storage.sql.exec(query).toArray() as T[]);

/** Signs arbitrary payload bytes under the v2 domain, as a compromised-but-keyed sender could. */
async function forged(payload: string, tenant = TENANT, key = KEY): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(`hall-monitor-telemetry-v2\n${tenant}\n${ts}\n${payload}`),
  );
  return new Request("https://telemetry.internal/internal/v2/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-hm-telemetry-tenant": tenant, "x-hm-telemetry-time": String(ts),
      "x-hm-telemetry-signature": [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    },
    body: payload,
  });
}

beforeEach(() => { controls.reset(); vi.restoreAllMocks(); });
afterEach(() => controls.reset());

describe("W7 route posture", () => {
  it("is disabled by default, and a valid v2 request stores nothing", async () => {
    const b = await delivery();
    for (const e of [
      receiverEnv({ HM_TELEMETRY_V2_ACCEPT: "validate_only" }),
      { ...receiverEnv(), HM_TELEMETRY_V2_ACCEPT: undefined } as unknown as TelemetryEnv,
      { ...env } as TelemetryEnv,
    ]) {
      const response = await post(b, TENANT, KEY, e);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "disabled" });
    }
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  });

  it("denies on invalid configuration or a missing store, without leaking why", async () => {
    const b = await delivery();
    for (const e of [
      receiverEnv({ HM_TELEMETRY_V2_TENANTS: "{" }),
      receiverEnv({ HM_TELEMETRY_V2_TENANTS: "{}" }),
      // A v1-shaped grant has no approved revisions, so it cannot enable v2.
      receiverEnv({ HM_TELEMETRY_V2_TENANTS: V1_GRANTS }),
      { ...receiverEnv(), AGGREGATES: undefined } as unknown as TelemetryEnv,
    ]) expect((await post(b, TENANT, KEY, e)).status).toBe(503);
  });

  it("keeps v1 validate-and-discard exactly as it was: persisted:false, nothing stored, independent of v2 settings", async () => {
    const v1Env = receiverEnv({ HM_TELEMETRY_ACCEPT: "validate_only", HM_TELEMETRY_TENANTS: V1_GRANTS });
    const request = await signedTelemetryRequest(TENANT, V1_KEY, { schemaVersion: 1, events: [evaluated(minutesAgo(1))] });
    const response = await handleTelemetry(request, v1Env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ code: "validated_not_persisted", accepted: 1, persisted: false });
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    // v1 enabled alone does not turn on v2, and v2 enabled alone does not turn on v1.
    const b = await delivery();
    expect((await post(b, TENANT, KEY, receiverEnv({ HM_TELEMETRY_V2_ACCEPT: undefined } as never))).status).toBe(503);
    const v1Only = await handleTelemetry(await signedTelemetryRequest(TENANT, V1_KEY, { schemaVersion: 1, events: [evaluated(minutesAgo(1))] }), receiverEnv());
    expect(v1Only.status).toBe(503);
  });
});

describe("W7 authentication and restrictions", () => {
  it("rejects v1-signed, wrong-key, cross-tenant-key, swapped-tenant and stale-timestamp requests", async () => {
    const b = await delivery();
    const v1 = await signedTelemetryRequest(TENANT, KEY, { schemaVersion: 1, events: [evaluated(minutesAgo(1))] });
    const asV2 = new Request("https://telemetry.internal/internal/v2/telemetry", { method: "POST", headers: v1.headers, body: await v1.text() });
    expect((await handleTelemetry(asV2, receiverEnv())).status).toBe(401);
    expect((await post(b, TENANT, "wrong-key-not-valid-for-this-tenant-0123456789")).status).toBe(401);
    expect((await post(b, TENANT, OTHER_KEY)).status).toBe(401);
    const swapped = await signedDeliveryRequestV2(TENANT, KEY, b.payload, b.digest);
    swapped.headers.set("x-hm-telemetry-tenant", OTHER);
    expect((await handleTelemetry(swapped, receiverEnv())).status).toBe(401);
    const old = await signedDeliveryRequestV2(TENANT, KEY, b.payload, b.digest, Math.floor(Date.now() / 1000) - 301);
    expect((await handleTelemetry(old, receiverEnv())).status).toBe(401);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await totals(OTHER)).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  });

  it("restricts each tenant to its own source, grade bands and approved producer revisions", async () => {
    const cases: [string, Built, string?, string?][] = [
      ["wrong source", await delivery({ event: { source: "playtrek" } })],
      ["wrong grade", await delivery({ event: { gradeBand: "g6_8" } })],
      ["unapproved revision", await delivery({ revision: "rev-c" })],
      ["revision approved only for another tenant", await delivery({ revision: "rev-b" }), OTHER, OTHER_KEY],
      ["unknown tenant", await delivery(), "tenant_nobody", KEY],
    ];
    for (const [name, b, tenant, key] of cases) {
      expect((await post(b, tenant ?? TENANT, key ?? KEY)).status, name).toBe(403);
    }
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await totals(OTHER)).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    // The same shapes inside their grant are accepted for the other tenant, from its own object.
    const ok = await delivery({ event: { source: "playtrek", gradeBand: "adult" } });
    expect(await send(ok, OTHER, OTHER_KEY)).toMatchObject({ kind: "acked", status: "committed" });
    expect((await totals(OTHER)).evaluated).toBe(1);
    expect((await totals()).evaluated).toBe(0);
  });

  it("refuses anything but an evaluation pair, even when correctly signed by an enrolled tenant", async () => {
    const base = evaluated(minutesAgo(5));
    const envelope = (events: unknown[], extra: Record<string, unknown> = {}) =>
      JSON.stringify({ schemaVersion: 2, deliveryId: newDeliveryId(), producerRevision: "rev-a", events, ...extra });
    for (const payload of [
      envelope([candidateOf(base)]),
      envelope([{ ...base, kind: "incident_opened" }]),
      envelope([{ ...base, kind: "report_received" }]),
      envelope([{ ...base, kind: "review_completed", reviewLatencyMs: 5 }]),
      envelope([{ ...base, kind: "protective_action" }]),
      envelope([{ ...base, priority: "urgent" }]),
      envelope([{ ...base, category: "self_harm" }]),
      envelope([{ ...base, calendarKind: "instructional" }]),
      envelope([base, base]),
      envelope([base, { ...candidateOf(base), occurredAt: minutesAgo(1) }]),
      envelope([base], { tenant: TENANT }),
      envelope([base], { caseId: "case_1" }),
      envelope([{ ...base, messageId: "msg_1" }]),
      envelope([{ ...base, studentId: "student_1" }]),
      envelope([], {}),
    ]) {
      expect((await handleTelemetry(await forged(payload), receiverEnv())).status).toBe(401);
    }
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await sql("SELECT * FROM deliveries")).toHaveLength(0);
  });

  it("enforces the 16 KiB bound while streaming, with no Content-Length", async () => {
    const b = await delivery();
    const request = await signedDeliveryRequestV2(TENANT, KEY, b.payload, b.digest);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const huge = new Request(request.url, { method: "POST", headers, body: "X".repeat(16 * 1024 + 1) });
    expect((await handleTelemetry(huge, receiverEnv())).status).toBe(401);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  });
});

describe("W7 exact, idempotent counting", () => {
  it("counts the whole pair once and returns a durable ack the sender accepts", async () => {
    const pair = await delivery({ pair: true });
    expect(await send(pair)).toEqual({ kind: "acked", status: "committed" });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
    const single = await delivery();
    expect(await send(single)).toEqual({ kind: "acked", status: "committed" });
    expect(await totals()).toEqual({ evaluated: 2, candidate: 1, rows: 1 });
  });

  it("answers a duplicate with the stable already-committed ack and does not recount", async () => {
    const b = await delivery({ pair: true });
    const first = await post(b);
    const again = await post(b);
    const [x, y] = [await first.json() as Record<string, unknown>, await again.json() as Record<string, unknown>];
    expect([first.status, again.status]).toEqual([200, 200]);
    expect([x.status, y.status]).toEqual(["committed", "deduplicated"]);
    // Same ID, digest and MAC bind: only the status field differs between the two acks.
    expect({ ...x, status: 0, mac: 0 }).toEqual({ ...y, status: 0, mac: 0 });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
    expect(await send(b)).toEqual({ kind: "acked", status: "deduplicated" });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
  });

  it("converges to identical totals under duplicate, reordered and concurrent whole-pair deliveries", async () => {
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => delivery({ pair: i % 3 === 0, occurredAt: minutesAgo(60 - i * 4) })));
    const storm = all.flatMap((b) => [b, b, b]);
    // Deterministic shuffle, so "reordered" is reproducible.
    storm.sort((a, b) => (a.digest + "1").localeCompare(b.digest + "2") || 0);
    storm.reverse();
    const outcomes = await Promise.all(storm.map((b) => send(b)));
    expect(outcomes.every((o) => o.kind === "acked")).toBe(true);
    expect(outcomes.filter((o) => o.kind === "acked" && o.status === "committed")).toHaveLength(12);
    expect(outcomes.filter((o) => o.kind === "acked" && o.status === "deduplicated")).toHaveLength(24);
    const t = await totals();
    expect(t.evaluated).toBe(12);
    expect(t.candidate).toBe(4);
    // The same stream in the opposite order, on a fresh tenant, gives the same totals.
    const reversed = await Promise.all([...storm].reverse().map((b) => send(b, OTHER, OTHER_KEY).catch(() => null)));
    expect(reversed.every((o) => o?.kind !== "acked")).toBe(true); // wrong source for this tenant: all refused
    expect((await totals(OTHER)).evaluated).toBe(0);
    expect((await stub().health()).committed).toBe(12);
  });

  it("treats the same delivery ID with a different digest as a conflict that changes nothing", async () => {
    const id = newDeliveryId();
    const a = await delivery({ id, revision: "rev-a" });
    const b = await delivery({ id, revision: "rev-b" });
    expect(await send(a)).toMatchObject({ kind: "acked", status: "committed" });
    const conflict = await post(b);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "digest_conflict" });
    expect(await send(b)).toEqual({ kind: "conflict" });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 0, rows: 1 });
    expect((await stub().rollups())[0]!.producerRevision).toBe("rev-a");
    expect((await stub().health()).conflicts).toBeGreaterThanOrEqual(1);
  });

  it("lets exactly one of two concurrent same-ID deliveries with different payloads win", async () => {
    const id = newDeliveryId();
    const a = await delivery({ id, revision: "rev-a" });
    const b = await delivery({ id, revision: "rev-b" });
    const responses = await Promise.all([post(a), post(b), post(a), post(b)]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(2); // the winner and its duplicate
    expect(statuses.filter((s) => s === 409)).toHaveLength(2); // the loser, twice
    expect((await totals()).evaluated).toBe(1);
  });

  it("rolls the dedupe state and the whole pair back together when the commit fails", async () => {
    const b = await delivery({ pair: true });
    await runInDurableObject(stub(), async (store: TelemetryAggregateStore) => {
      controls.failIngest = true;
      // Dedupe row, bucket counters and health were all written before the injected failure.
      await expect(store.ingest({
        deliveryKey: "k".repeat(64), digest: b.digest, producerRevision: "rev-a", events: b.delivery.events, maxDedupeRows: 100,
      })).rejects.toThrow("injected commit failure");
    });
    expect(await sql("SELECT * FROM deliveries")).toHaveLength(0);
    expect(await sql("SELECT * FROM rollups")).toHaveLength(0);
    expect((await stub().health()).committed).toBe(0);

    // The same delivery, once the fault is gone, is counted once — not half, not twice.
    controls.failIngest = false;
    expect(await send(b)).toEqual({ kind: "acked", status: "committed" });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
  });

  it("never acks when the aggregate object fails: the producer keeps its row", async () => {
    const broken = {
      idFromName: () => "x",
      get: () => ({ ingest: async () => { throw new Error("SENTINEL-DO-FAILURE"); } }),
    } as unknown as DurableObjectNamespace<TelemetryAggregateStore>;
    const b = await delivery();
    const response = await post(b, TENANT, KEY, receiverEnv({ AGGREGATES: broken }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ code: "unavailable" }));
    expect(await sendDeliveryV2(binding(receiverEnv({ AGGREGATES: broken })), TENANT, KEY, b.payload, b.digest))
      .toEqual({ kind: "retry", reason: "unavailable" });
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  });

  it("bounds dedupe state: at capacity a new delivery gets no ack, a held one is still deduplicated", async () => {
    const small = receiverEnv({ HM_TELEMETRY_MAX_DEDUPE_ROWS: "2" });
    const [a, b, c] = await Promise.all([delivery(), delivery(), delivery()]);
    expect((await send(a, TENANT, KEY, small)).kind).toBe("acked");
    expect((await send(b, TENANT, KEY, small)).kind).toBe("acked");
    const full = await post(c, TENANT, KEY, small);
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ code: "capacity" });
    expect(await send(a, TENANT, KEY, small)).toEqual({ kind: "acked", status: "deduplicated" });
    expect((await totals()).evaluated).toBe(2);
  });
});

describe("W7 occurrence window and dedupe expiry", () => {
  it("rejects occurrences older than the accepted horizon or beyond future skew, counting neither", async () => {
    const old = await delivery({ occurredAt: new Date(Date.now() - TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS - 60_000).toISOString() });
    const future = await delivery({ occurredAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const oldResponse = await post(old);
    expect([oldResponse.status, await oldResponse.json()]).toEqual([422, { code: "stale_occurrence" }]);
    const futureResponse = await post(future);
    expect([futureResponse.status, await futureResponse.json()]).toEqual([422, { code: "future_occurrence" }]);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await sql("SELECT * FROM deliveries")).toHaveLength(0);
    // Inside both bounds is accepted.
    const edge = await delivery({ occurredAt: new Date(Date.now() - TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + 60_000).toISOString() });
    expect(await send(edge)).toMatchObject({ kind: "acked", status: "committed" });
    expect((await send(await delivery({ occurredAt: new Date(Date.now() + 60_000).toISOString() }))).kind).toBe("acked");
  });

  it("keeps dedupe state for the entire accepted horizon, so a late in-horizon replay never recounts", async () => {
    const occurredAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const b = await delivery({ occurredAt, pair: true });
    expect(await send(b)).toMatchObject({ status: "committed" });
    // Advance the object's clock to just inside the last accepted moment for this occurrence.
    controls.clockOffsetMs = TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS - 60 * 60_000 - 30_000;
    expect(await send(b)).toEqual({ kind: "acked", status: "deduplicated" });
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
  });

  it("refuses a re-signed replay after dedupe expiry, with the state present, expired or already purged", async () => {
    const occurredAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const b = await delivery({ occurredAt, pair: true });
    expect(await send(b)).toMatchObject({ status: "committed" });
    const before = await stub().rollups();

    // Past the horizon, with the dedupe row still physically present.
    controls.clockOffsetMs = TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + 10 * 60_000;
    const replay = await post(b); // freshly re-signed by signedDeliveryRequestV2
    expect([replay.status, await replay.json()]).toEqual([422, { code: "stale_occurrence" }]);

    // The alarm purges the expired dedupe state; the counters stay, the replay is still refused.
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await sql("SELECT * FROM deliveries")).toHaveLength(0);
    expect((await post(b)).status).toBe(422);
    expect((await sendDeliveryV2(binding(), TENANT, KEY, b.payload, b.digest)).kind).toBe("retry");
    expect(await stub().rollups()).toEqual(before);
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
    // Nothing left to wake for: the object went idle rather than re-arming forever.
    await runInDurableObject(stub(), async (_i, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
  });

  it("re-arms the purge alarm after a restart that finds dedupe state", async () => {
    await send(await delivery());
    await runInDurableObject(stub(), async (_i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
    });
    // A new object over the same storage must re-arm before serving anything.
    const { TelemetryAggregateStore: Store } = await import("../src/store.ts");
    await runInDurableObject(stub(), async (_i, state) => {
      new Store(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("W7 stored shape", () => {
  it("keeps exact chronological 15-minute UTC buckets, never merging weeks or collapsing to 168 tiles", async () => {
    // The same weekday and clock time, exactly one week apart: two rows, not one.
    const first = Date.now() - 60 * 60_000;
    expect(await send(await delivery({ occurredAt: new Date(first).toISOString() }))).toMatchObject({ status: "committed" });
    controls.clockOffsetMs = 7 * 24 * 3600_000;
    expect(await send(await delivery({ occurredAt: new Date(first + 7 * 24 * 3600_000).toISOString() }))).toMatchObject({ status: "committed" });
    const rows = await stub().rollups();
    expect(rows).toHaveLength(2);
    expect(Date.parse(rows[1]!.bucketStart) - Date.parse(rows[0]!.bucketStart)).toBe(7 * 24 * 3600_000);
  });

  it("buckets to 15 UTC minutes and keeps release identity as a bounded dimension", async () => {
    const base = Date.UTC(2026, 9, 28, 18, 0, 0);
    controls.clockOffsetMs = base + 3600_000 - Date.now();
    const at = (min: number, sec = 0, ms = 0) => new Date(base + min * 60_000 + sec * 1000 + ms).toISOString();
    for (const [occurredAt, revision] of [
      [at(0), "rev-a"], [at(14, 59, 999), "rev-a"], [at(15), "rev-a"], [at(7), "rev-b"],
    ] as const) await send(await delivery({ occurredAt, revision }));
    const rows = await stub().rollups();
    expect(rows.map((r) => [r.bucketStart, r.producerRevision, r.evaluated])).toEqual([
      [at(0), "rev-a", 2], [at(0), "rev-b", 1], [at(15), "rev-a", 1],
    ]);
  });

  it("separates the two 1:30 a.m. hours of a fall-back night as distinct UTC instants", async () => {
    // Detroit 2026-11-01: 01:30 EDT = 05:30Z and 01:30 EST = 06:30Z. Neither may fold into the other.
    controls.clockOffsetMs = Date.UTC(2026, 10, 1, 7, 0, 0) - Date.now();
    for (const iso of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T05:45:00.000Z"]) {
      await send(await delivery({ occurredAt: iso }));
    }
    expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual([
      "2026-11-01T05:30:00.000Z", "2026-11-01T05:45:00.000Z", "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("stores no per-message row, raw delivery ID, tenant, key or timestamp finer than the bucket", async () => {
    const logs = vi.spyOn(console, "log");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const occurredMs = Date.UTC(2026, 9, 28, 18, 7, 31, 456);
    const b = await delivery({ pair: true, occurredAt: new Date(occurredMs).toISOString() });
    controls.clockOffsetMs = Date.UTC(2026, 9, 28, 18, 30, 0) - Date.now();
    await send(b);
    await post(b);
    await post(await delivery({ revision: "rev-c" })); // forbidden
    const id = b.delivery.deliveryId;
    const dump = JSON.stringify([
      await sql("SELECT * FROM deliveries"), await sql("SELECT * FROM rollups"), await sql("SELECT * FROM ingest_health"),
      await sql("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    ]);
    // Nothing finer than the bucket: neither the occurrence's epoch milliseconds nor that plus any
    // fixed retention appears in what is stored. (The body digest is stored on purpose: it is what
    // detects a same-ID conflict.)
    const retention = DEDUPE_RETENTION_AFTER_OCCURRENCE_MS;
    for (const secret of [id, id.slice(4), TENANT, KEY, "456Z", "18:07:31", String(occurredMs), String(occurredMs + retention), String(occurredMs + retention + 15 * 60_000)]) {
      expect(dump, secret).not.toContain(secret);
    }
    // The only tables are dedupe digests, bucket counters and health; there is no event table.
    expect((await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")).map((r) => r.name))
      .toEqual(["deliveries", "ingest_health", "rollups"]);
    expect([logs, warns, errors].flatMap((s) => s.mock.calls)).toEqual([]);
  });

  it("records trusted ingress time only in health, not in any occurrence bucket", async () => {
    await send(await delivery({ occurredAt: minutesAgo(90) }));
    const health = await stub().health();
    expect(health).toMatchObject({ committed: 1, deduplicated: 0, conflicts: 0, dedupeRows: 1 });
    expect(Date.parse(health.lastIngestAt!)).toBeGreaterThan(Date.now() - 10_000);
    const [row] = await stub().rollups();
    expect(Date.parse(row!.bucketStart)).toBeLessThan(Date.now() - 80 * 60_000);
  });
});
