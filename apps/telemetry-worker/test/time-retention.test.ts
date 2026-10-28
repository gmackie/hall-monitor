// W8a: trusted time pinning, correction revisions, and retention enforced by the real receiver and
// the real SQLite Durable Object. Every value (approval references, durations, zones, districts)
// is synthetic: nothing here is an approved retention or a real tenant.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { newDeliveryId } from "@gmacko/hall-monitor-telemetry-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelemetry } from "../src/index.ts";
import { TelemetryAggregateStore as Store } from "../src/store.ts";
import { controls } from "./controls.ts";
import { policyDoc } from "./fixtures.ts";
import {
  FIXED_POLICY, GRANTS, KEY, OTHER, OTHER_KEY, TENANT, at, count, delivery, expectNothingStored, fixedConfig, fixedInterval,
  forged, post, receiverEnv, send, sql, stub, totals,
} from "./receiver.ts";

const alarm = () => runDurableObjectAlarm(stub());
const rollupDump = () => stub().rollups().then((rows) => JSON.stringify(rows));

beforeEach(() => { controls.reset(); vi.restoreAllMocks(); });
afterEach(() => controls.reset());

describe("W8a admission: the server owns time, calendar, revisions and retention", () => {
  // One test per configuration, not one loop over all of them: each request is a full Worker +
  // Durable Object round trip, and a single test running ten of them in sequence took time
  // proportional to the case count (it reached the 5 s limit under CPU contention). Each case keeps
  // its own isolated storage, so "nothing stored" is checked against an object that started empty.
  const lapsed = policyDoc(0, { effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2026-10-28T12:00:00Z" });
  const future = policyDoc(0, { effectiveFrom: "2026-11-01T00:00:00Z", approvedUntil: "2027-11-01T00:00:00Z" });
  const REFUSED: readonly (readonly [string, () => string | undefined, number, string])[] = [
    ["no configuration", () => undefined, 503, "invalid_configuration"],
    ["unparseable configuration", () => "{", 503, "invalid_configuration"],
    ["tenant absent from configuration", () => fixedConfig({}, {}).replace(`"${TENANT}"`, '"tenant_other"'), 503, "invalid_configuration"],
    ["conflicting source", () => fixedConfig({ source: "playtrek" }), 503, "invalid_configuration"],
    ["interval approves a revision the grant does not", () => fixedConfig({ intervals: [fixedInterval({ producerRevisions: ["rev-a", "rev-z"] })] }), 503, "invalid_configuration"],
    ["retention approval expired", () => fixedConfig({ retention: lapsed }), 403, "retention_unapproved"],
    ["retention approval not yet effective", () => fixedConfig({ retention: future }), 403, "retention_unapproved"],
    ["occurrence outside every configured interval", () => fixedConfig({ intervals: [fixedInterval({ from: "2026-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" })] }), 422, "unconfigured_occurrence"],
    ["revision not approved for the interval", () => fixedConfig({ intervals: [fixedInterval({ producerRevisions: ["rev-b"] })] }), 403, "forbidden"],
    // A tenant with grants but no configuration of its own is forbidden, and the others are unaffected.
    ["configuration only for an unknown tenant", () => fixedConfig({}, {}).replace(`"${TENANT}"`, '"tenant_zzz"'), 503, "invalid_configuration"],
    ["no configuration for this tenant (another tenant's only)", () => JSON.stringify({ [OTHER]: JSON.parse(fixedConfig())[OTHER] }), 403, "forbidden"],
  ];

  it.each(REFUSED)("stores nothing for %s", async (name, config, status, code) => {
    at("2026-10-28T18:10:00Z");
    const b = await delivery("2026-10-28T18:05:00.000Z");
    const response = await post(b, receiverEnv(config() as string));
    expect([response.status, await response.json()], name).toEqual([status, { code }]);
    await expectNothingStored();
    await expectNothingStored(OTHER);
  });

  it("accepts the same delivery under valid configuration: only configuration was missing", async () => {
    at("2026-10-28T18:10:00Z");
    const b = await delivery("2026-10-28T18:05:00.000Z");
    expect(await send(b, receiverEnv(fixedConfig()))).toEqual({ kind: "acked", status: "committed" });
  });

  it("ignores anything a producer says about time: extra fields and a claimed calendar are refused, stored dimensions come from the server", async () => {
    at("2026-10-28T18:10:00Z");
    const good = await delivery("2026-10-28T18:05:00.000Z");
    const envelope = JSON.parse(good.payload) as Record<string, unknown> & { events: Record<string, unknown>[] };
    const forge = async (payload: Record<string, unknown>) =>
      (await handleTelemetry(await forged(JSON.stringify(payload)), receiverEnv(fixedConfig()))).status;
    for (const extra of [
      { timeZone: "Pacific/Honolulu" }, { localHour: 3 }, { localDate: "2026-01-01" }, { calendarRevision: "cal-x" },
      { configRevision: "cfg-x" }, { retention: { rollupSeconds: 1 } }, { weekStartingMonday: "2026-01-05" }, { utcOffsetMinutes: 0 },
    ]) expect(await forge({ ...envelope, ...extra }), JSON.stringify(extra)).toBe(401);
    for (const event of [{ calendarKind: "holiday" }, { timeZone: "UTC" }, { localHour: 1 }, { weekday: 0 }, { calendarRevision: "x" }]) {
      expect(await forge({ ...envelope, events: [{ ...envelope.events[0], ...event }] }), JSON.stringify(event)).toBe(401);
    }
    await expectNothingStored();

    // Accepted: the stored dimensions are the server's. The calendar says this Detroit date is a holiday.
    const config = fixedConfig({ intervals: [fixedInterval({ calendar: [{ from: "2026-10-28", to: "2026-10-28", kind: "holiday" }] })] });
    expect(await send(good, receiverEnv(config))).toEqual({ kind: "acked", status: "committed" });
    const [row] = await stub().rollups();
    expect(row!.time).toEqual({
      configRevision: "cfg-edu-1", calendarRevision: "cal-a", timeZone: "America/Detroit", localDate: "2026-10-28", localHour: 14,
      weekday: 2, weekStartingMonday: "2026-10-26", utcOffsetMinutes: -240, calendarKind: "holiday",
    });
  });

  it("separates the repeated fall-back hour as distinct rows, with their own offsets", async () => {
    at("2026-11-01T07:00:00Z");
    const e = receiverEnv(fixedConfig());
    for (const iso of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T05:45:00.000Z", "2026-11-01T06:45:00.000Z"]) {
      expect(await send(await delivery(iso), e)).toMatchObject({ status: "committed" });
    }
    const rows = await stub().rollups();
    expect(rows.map((r) => [r.bucketStart, r.time!.localDate, r.time!.localHour, r.time!.utcOffsetMinutes])).toEqual([
      ["2026-11-01T05:30:00.000Z", "2026-11-01", 1, -240],
      ["2026-11-01T05:45:00.000Z", "2026-11-01", 1, -240],
      ["2026-11-01T06:30:00.000Z", "2026-11-01", 1, -300],
      ["2026-11-01T06:45:00.000Z", "2026-11-01", 1, -300],
    ]);
    expect(rows.every((r) => r.time!.weekStartingMonday === "2026-10-26" && r.time!.weekday === 6)).toBe(true);
  });

  it("pins each occurrence to the interval effective for it and approves producer revisions per interval", async () => {
    at("2026-10-28T18:20:00Z");
    const config = fixedConfig({
      intervals: [
        fixedInterval({ from: "2026-01-01T00:00:00Z", to: "2026-10-28T18:15:00Z", calendarRevision: "cal-1", producerRevisions: ["rev-a"] }),
        fixedInterval({ from: "2026-10-28T18:15:00Z", to: "2027-03-01T00:00:00Z", calendarRevision: "cal-2", timeZone: "America/Los_Angeles", producerRevisions: ["rev-a", "rev-b"] }),
      ],
    });
    const e = receiverEnv(config);
    expect(await send(await delivery("2026-10-28T18:14:59.999Z"), e)).toMatchObject({ status: "committed" });
    expect(await send(await delivery("2026-10-28T18:15:00.000Z"), e)).toMatchObject({ status: "committed" });
    const [before, after] = await stub().rollups();
    expect(before!.time).toMatchObject({ calendarRevision: "cal-1", timeZone: "America/Detroit", localHour: 14, utcOffsetMinutes: -240 });
    expect(after!.time).toMatchObject({ calendarRevision: "cal-2", timeZone: "America/Los_Angeles", localHour: 11, utcOffsetMinutes: -420 });
    // rev-b is approved only for the later interval.
    expect((await post(await delivery("2026-10-28T18:10:00.000Z", { revision: "rev-b" }), e)).status).toBe(403);
    expect(await send(await delivery("2026-10-28T18:16:00.000Z", { revision: "rev-b" }), e)).toMatchObject({ status: "committed" });
    // An occurrence in a gap between intervals is refused, never assigned a neighbour's revision.
    const gapped = receiverEnv(fixedConfig({ intervals: [
      fixedInterval({ from: "2026-01-01T00:00:00Z", to: "2026-10-28T18:00:00Z", calendarRevision: "cal-1" }),
      fixedInterval({ from: "2026-10-28T19:00:00Z", to: "2027-03-01T00:00:00Z", calendarRevision: "cal-2" }),
    ] }));
    const refused = await post(await delivery("2026-10-28T18:30:00.000Z"), gapped);
    expect([refused.status, await refused.json()]).toEqual([422, { code: "unconfigured_occurrence" }]);
    expect((await totals()).evaluated).toBe(3);
  });

  it("keeps the same producer revision in separate rows when the configuration revision differs", async () => {
    at("2026-10-28T18:10:00Z");
    const first = receiverEnv(fixedConfig());
    const second = receiverEnv(fixedConfig({ configRevision: "cfg-edu-2" }));
    await send(await delivery("2026-10-28T18:05:00.000Z"), first);
    await send(await delivery("2026-10-28T18:06:00.000Z"), second);
    const rows = await stub().rollups();
    expect(rows.map((r) => [r.time!.configRevision, r.evaluated, r.revision])).toEqual([["cfg-edu-1", 1, 1], ["cfg-edu-2", 1, 1]]);
  });
});

describe("W8a visible correction revisions", () => {
  it("advances a bucket's revision once per new committed delivery, late ones included, and never for anything else", async () => {
    const e = receiverEnv(fixedConfig());
    at("2026-10-28T18:10:00Z"); // 18:00-18:15 is still open
    const d1 = await delivery("2026-10-28T18:05:00.000Z");
    expect(await send(d1, e)).toMatchObject({ status: "committed" });
    let [row] = await stub().rollups();
    expect(row).toMatchObject({ evaluated: 1, candidate: 0, revision: 1, lateRevisions: 0, provisional: true, completeness: "unavailable" });

    at("2026-10-28T18:40:00Z"); // the bucket has closed: a new delivery for it is a correction
    const d2 = await delivery("2026-10-28T18:07:00.000Z", { pair: true });
    expect(await send(d2, e)).toMatchObject({ status: "committed" });
    [row] = await stub().rollups();
    expect(row).toMatchObject({ bucketStart: "2026-10-28T18:00:00.000Z", evaluated: 2, candidate: 1, revision: 2, lateRevisions: 1, provisional: true });
    const settled = await rollupDump();

    // Exact duplicate, same-ID/different-body conflict, stale, future, unapproved, unconfigured: no counter, no revision.
    expect(await send(d2, e)).toEqual({ kind: "acked", status: "deduplicated" });
    expect((await post(await delivery("2026-10-28T18:07:00.000Z", { id: d2.delivery.deliveryId, revision: "rev-b" }), e)).status).toBe(409);
    expect((await post(await delivery("2026-10-27T18:00:00.000Z"), e)).status).toBe(422); // older than the accepted horizon
    expect((await post(await delivery("2026-10-28T18:50:00.000Z"), e)).status).toBe(422); // beyond future skew
    expect((await post(await delivery("2026-10-28T18:07:00.000Z", { revision: "rev-c" }), e)).status).toBe(403);
    expect((await post(await delivery("2026-10-28T18:07:00.000Z", { event: { gradeBand: "g6_8" } }), e)).status).toBe(403);
    expect(await rollupDump()).toBe(settled);

    // A late delivery for an earlier bucket revises THAT bucket (original occurrence), not the arrival one.
    expect(await send(await delivery("2026-10-28T18:20:00.000Z"), e)).toMatchObject({ status: "committed" });
    const rows = await stub().rollups();
    expect(rows.map((r) => [r.bucketStart, r.evaluated, r.revision, r.lateRevisions])).toEqual([
      ["2026-10-28T18:00:00.000Z", 2, 2, 1],
      ["2026-10-28T18:15:00.000Z", 1, 1, 1],
    ]);
    // Numerator and denominator share one row, so they always match source, grade band, modality and revisions.
    expect(rows[0]!.candidate).toBeLessThanOrEqual(rows[0]!.evaluated);
  });

  it("marks a bucket final only after the late-arrival window has passed", async () => {
    at("2026-10-28T18:10:00Z");
    await send(await delivery("2026-10-28T18:05:00.000Z"), receiverEnv(fixedConfig()));
    expect((await stub().rollups())[0]!.provisional).toBe(true);
    at("2026-10-29T18:15:00Z"); // bucket end + 24 h: a replay up to 5 more minutes could still arrive
    expect((await stub().rollups())[0]!.provisional).toBe(true);
    at("2026-10-29T18:20:01Z");
    expect((await stub().rollups())[0]!.provisional).toBe(false);
  });

  it("converges to the same counters and revisions whatever order late deliveries arrive in", async () => {
    // Playtrek and educateos share a configuration shape, so the same stream runs against both tenants.
    const e = receiverEnv(fixedConfig());
    at("2026-10-28T19:00:00Z");
    const stream = (event: Record<string, unknown>) => [
      ["2026-10-28T18:05:00.000Z", true], ["2026-10-28T18:20:00.000Z", false], ["2026-10-28T18:08:00.000Z", false], ["2026-10-28T18:35:00.000Z", true],
    ].map(([iso, pair]) => delivery(iso as string, { pair: pair as boolean, event }));
    const forward = await Promise.all(stream({}));
    const backward = await Promise.all(stream({ source: "playtrek" }));
    for (const b of forward) await send(b, e);
    for (const b of [...backward].reverse()) await send(b, e, OTHER, OTHER_KEY);
    const shape = async (tenant: string) =>
      (await stub(tenant).rollups()).map((r) => [r.bucketStart, r.evaluated, r.candidate, r.revision, r.lateRevisions]);
    expect(await shape(TENANT)).toEqual(await shape(OTHER));
    expect((await shape(TENANT)).length).toBe(3);
  });
});

describe("W8a retention: expiry, replay safety and read-time exclusion", () => {
  // Fictional durations: rollups for ~28 h (100 000 s rounds up to 28 h on the 15-minute grid).
  const SHORT = policyDoc(0, { effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2030-01-01T00:00:00Z", rollupSeconds: 100_000, gapSeconds: 100_000 });
  const shortEnv = () => receiverEnv(fixedConfig({ retention: SHORT }));

  it("expires health, dedupe state and rollups on their own schedules, and an expired total is never recreated by replay", async () => {
    const e = shortEnv();
    at("2026-10-28T18:10:00Z");
    const b = await delivery("2026-10-28T17:00:00.000Z", { pair: true });
    expect(await send(b, e)).toMatchObject({ status: "committed" });
    const expiries = await sql<{ d: number; r: number; h: number }>(
      "SELECT (SELECT expires_at FROM deliveries) AS d, (SELECT expires_at FROM rollups) AS r, (SELECT expires_at FROM ingest_health) AS h");
    // Bucket 17:00-17:15 ends 17:15. Dedupe: +24h15m. Rollup: +28h. Health: 18:10 + 1h, rounded up to 19:15.
    expect(expiries.map((x) => [new Date(x.d).toISOString(), new Date(x.r).toISOString(), new Date(x.h).toISOString()])).toEqual([
      ["2026-10-29T17:30:00.000Z", "2026-10-29T21:15:00.000Z", "2026-10-28T19:15:00.000Z"],
    ]);

    // Health expires first. It is excluded from reads before any alarm, then deleted by the alarm.
    at("2026-10-28T19:30:00Z");
    expect(await stub().health()).toMatchObject({ lastIngestAt: null, committed: 0, deduplicated: 0, conflicts: 0 });
    expect((await sql<{ committed: number }>("SELECT committed FROM ingest_health"))[0]!.committed).toBe(1);
    expect(await alarm()).toBe(true);
    expect((await sql<{ committed: number }>("SELECT committed FROM ingest_health"))[0]!.committed).toBe(0);
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });

    // Dedupe state expires next (a read excludes it first), the rollup is still live.
    at("2026-10-29T17:31:00Z");
    expect((await stub().health()).dedupeRows).toBe(0);
    expect(await count("deliveries")).toBe(1);
    expect(await alarm()).toBe(true);
    expect(await count("deliveries")).toBe(0);
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });
    // A re-signed replay of that very delivery is now older than the accepted horizon: refused, not recounted.
    const replay = await post(b, e);
    expect([replay.status, await replay.json()]).toEqual([422, { code: "stale_occurrence" }]);
    expect(await totals()).toEqual({ evaluated: 1, candidate: 1, rows: 1 });

    // The rollup expires last: excluded from reads before the alarm, deleted by it, never recreated.
    at("2026-10-29T21:16:00Z");
    expect(await stub().rollups()).toEqual([]);
    expect(await count("rollups")).toBe(1);
    await alarm();
    expect(await count("rollups")).toBe(0);
    expect((await post(b, e)).status).toBe(422);
    expect((await send(b, e)).kind).toBe("retry");
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    // A different delivery for the same long-gone bucket cannot recreate it either.
    expect((await post(await delivery("2026-10-28T17:05:00.000Z"), e)).status).toBe(422);
    expect(await count("rollups")).toBe(0);
    // Everything stored has now expired, so the object went idle.
    expect(await count("deliveries")).toBe(0);
    await runInDurableObject(stub(), async (_i, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
  });

  it("re-arms cleanup after a restart that finds only rollups, and deletes what expired while the object was away", async () => {
    const e = shortEnv();
    at("2026-10-28T18:10:00Z");
    await send(await delivery("2026-10-28T17:00:00.000Z"), e);
    at("2026-10-29T17:31:00Z");
    await alarm(); // dedupe and health are gone; only the rollup (expiring 21:15) remains
    expect(await count("deliveries")).toBe(0);
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
      new Store(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    // Restarting after the expiry deletes the rollup immediately, with no alarm having fired.
    at("2026-10-29T21:16:00Z");
    expect(await count("rollups")).toBe(1);
    await runInDurableObject(stub(), async (_i, state) => {
      class Aged extends Store { protected override now() { return Date.parse("2026-10-29T21:16:00Z"); } }
      new Aged(state, env);
      await state.blockConcurrencyWhile(async () => {});
    });
    expect(await count("rollups")).toBe(0);
  });

  it("stores no approval reference, tenant, delivery ID or sub-bucket time, and logs nothing", async () => {
    const spies = (["log", "warn", "error", "info"] as const).map((level) => vi.spyOn(console, level));
    at("2026-10-28T18:10:00Z");
    const b = await delivery("2026-10-28T18:07:31.456Z", { pair: true });
    await send(b, receiverEnv(fixedConfig()));
    await send(b, receiverEnv(fixedConfig()));
    await post(b, receiverEnv(fixedConfig({ state: "revoked", revocationRef: "SYNTHETIC-REVOCATION-1" })));
    const dump = JSON.stringify([
      await sql("SELECT * FROM deliveries"), await sql("SELECT * FROM rollups"), await sql("SELECT * FROM ingest_health"),
      await sql("SELECT * FROM retention_state"),
    ]);
    const id = b.delivery.deliveryId;
    for (const secret of [id, id.slice(4), TENANT, KEY, "SYNTHETIC-TEST-ONLY", "SYNTHETIC-REVOCATION", "synthetic-policy", "456Z", "18:07:31", String(Date.parse("2026-10-28T18:07:31.456Z"))]) {
      expect(dump, secret).not.toContain(secret);
    }
    expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
  });

  it("applies a shortened policy at once and never extends stored data when a policy is lengthened", async () => {
    const policyB = policyDoc(0, { policyRevision: "synthetic-policy-2", effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2030-01-01T00:00:00Z", dedupeSeconds: 87_300, rollupSeconds: 87_300, gapSeconds: 87_300 });
    const long = receiverEnv(fixedConfig());
    const short = receiverEnv(fixedConfig({ retention: policyB }));

    // Shorten: data written under 30 days is deleted the moment the shorter policy is applied.
    at("2026-10-28T18:10:00Z");
    await send(await delivery("2026-10-28T17:00:00.000Z"), long);
    expect(await totals()).toMatchObject({ evaluated: 1 });
    at("2026-10-29T18:30:00Z");
    await send(await delivery("2026-10-29T18:20:00.000Z"), short);
    expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual(["2026-10-29T18:15:00.000Z"]);
    expect(await count("rollups")).toBe(1);
    expect((await stub().retention())).toMatchObject({ state: "active", policyRevision: "synthetic-policy-2" });

    // Lengthen: a row written under the short policy keeps its short expiry.
    at("2026-11-02T18:10:00Z");
    await send(await delivery("2026-11-02T17:00:00.000Z"), short);
    at("2026-11-03T18:30:00Z");
    await send(await delivery("2026-11-03T18:20:00.000Z"), long);
    expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual(["2026-11-03T18:15:00.000Z"]);
    expect(await count("rollups")).toBe(1);
  });

  describe("a shortened policy stays shortened when a longer one is applied before the short deadline", () => {
    // Fictional: 87 300 s is 24 h 15 min, already on the 15-minute grid.
    const SHORT_SECONDS = policyDoc(0, { policyRevision: "synthetic-policy-2", effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2030-01-01T00:00:00Z", dedupeSeconds: 87_300, rollupSeconds: 87_300, gapSeconds: 87_300 });
    const longEnv = () => receiverEnv(fixedConfig());
    const shortEnv87 = () => receiverEnv(fixedConfig({ retention: SHORT_SECONDS }));
    const OLD_BUCKET = "2026-10-28T17:00:00.000Z";
    // 17:00 bucket ends 17:15; the short rollup TTL puts its deadline at 2026-10-29 17:30.
    const SHORT_DEADLINE = "2026-10-29T17:30:00.000Z";
    const expiryOf = (table: "rollups" | "rollups_legacy", bucketStart: string) =>
      sql<{ expires_at: number }>(`SELECT expires_at FROM ${table} WHERE bucket_start = ${Date.parse(bucketStart)}`).then((r) => r.map((x) => new Date(x.expires_at).toISOString()));

    /** long -> short -> long, all before the short deadline. */
    async function longShortLong() {
      at("2026-10-28T18:10:00Z");
      expect(await send(await delivery("2026-10-28T17:00:00.000Z"), longEnv())).toMatchObject({ status: "committed" });
      at("2026-10-28T19:00:00Z");
      expect(await send(await delivery("2026-10-28T18:55:00.000Z"), shortEnv87())).toMatchObject({ status: "committed" });
      at("2026-10-28T20:00:00Z");
      expect(await send(await delivery("2026-10-28T19:55:00.000Z"), longEnv())).toMatchObject({ status: "committed" });
    }

    it("clamps the stored deadline of a current rollup, so reads and the alarm both honour the shorter policy", async () => {
      await longShortLong();
      expect(await expiryOf("rollups", OLD_BUCKET)).toEqual([SHORT_DEADLINE]);
      // The long policy is back in force, but the row only ever has the smaller deadline.
      expect(await stub().retention()).toMatchObject({ state: "active", policyRevision: "synthetic-policy-1" });
      at("2026-10-29T17:29:00Z");
      expect((await stub().rollups()).map((r) => r.bucketStart)).toContain(OLD_BUCKET);

      at("2026-10-29T17:31:00Z");
      // Read-time exclusion first, with the row still stored ...
      expect((await stub().rollups()).map((r) => r.bucketStart)).not.toContain(OLD_BUCKET);
      expect(await count("rollups")).toBe(3);
      // ... then the alarm really deletes it. The two later buckets are untouched.
      expect(await alarm()).toBe(true);
      expect(await count("rollups")).toBe(2);
      expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual(["2026-10-28T18:45:00.000Z", "2026-10-28T19:45:00.000Z"]);
      // And a re-signed replay cannot bring the bucket back.
      expect((await post(await delivery("2026-10-28T17:05:00.000Z"), longEnv())).status).toBe(422);
      expect(await count("rollups")).toBe(2);
    });

    it("a restart (which reads the lengthened policy) does not prolong it either", async () => {
      await longShortLong();
      at("2026-10-29T17:31:00Z");
      await runInDurableObject(stub(), async (_i, state) => {
        class Aged extends Store { protected override now() { return Date.parse("2026-10-29T17:31:00Z"); } }
        new Aged(state, env);
        await state.blockConcurrencyWhile(async () => {});
      });
      expect(await expiryOf("rollups", OLD_BUCKET)).toEqual([]);
      expect(await count("rollups")).toBe(2);
    });

    it("clamps a rollup written before W8a (legacy table) the same way, and the alarm deletes it", async () => {
      // A pre-W8a row as the migration leaves it: a ten-year ceiling and no dimensions.
      const bucket = Date.parse(OLD_BUCKET);
      await sql("SELECT 1"); // creates the object, and so its tables
      await runInDurableObject(stub(), (_i, state) => {
        state.storage.sql.exec("INSERT INTO rollups_legacy VALUES (?, 'educateos', 'g9_12', 'text', 'rev-a', 4, 1, ?)", bucket, bucket + 900_000 + 10 * 365 * 86_400_000);
      });
      at("2026-10-28T18:10:00Z");
      expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual([OLD_BUCKET]);
      at("2026-10-28T19:00:00Z");
      await send(await delivery("2026-10-28T18:55:00.000Z"), shortEnv87());
      at("2026-10-28T20:00:00Z");
      await send(await delivery("2026-10-28T19:55:00.000Z"), longEnv());
      expect(await expiryOf("rollups_legacy", OLD_BUCKET)).toEqual([SHORT_DEADLINE]);

      at("2026-10-29T17:31:00Z");
      expect((await stub().rollups()).map((r) => r.bucketStart)).not.toContain(OLD_BUCKET);
      expect(await count("rollups_legacy")).toBe(1);
      await alarm();
      expect(await count("rollups_legacy")).toBe(0);
    });

    it("does not extend a deadline when the lengthened policy is applied first, and tightens a legacy row that has no stored deadline", async () => {
      // short -> long: the row written under the short policy keeps its short deadline.
      at("2026-10-28T18:10:00Z");
      await send(await delivery("2026-10-28T17:00:00.000Z"), shortEnv87());
      at("2026-10-28T20:00:00Z");
      await send(await delivery("2026-10-28T19:55:00.000Z"), longEnv());
      expect(await expiryOf("rollups", OLD_BUCKET)).toEqual([SHORT_DEADLINE]);
      // A legacy row with a NULL deadline (the column is nullable) must not make the clamp a no-op.
      const bucket = Date.parse("2026-10-28T16:00:00.000Z");
      await runInDurableObject(stub(), (_i, state) => {
        state.storage.sql.exec("INSERT INTO rollups_legacy VALUES (?, 'educateos', 'g9_12', 'text', 'rev-a', 2, 0, NULL)", bucket);
      });
      at("2026-10-28T20:10:00Z");
      await send(await delivery("2026-10-28T20:05:00.000Z"), shortEnv87());
      expect(await expiryOf("rollups_legacy", "2026-10-28T16:00:00.000Z")).toEqual(["2026-10-29T16:30:00.000Z"]);
    });
  });

  it("refuses ingest when the approval lapses, keeps already stored data only for its own TTL, and stores nothing new", async () => {
    const lapsing = policyDoc(0, { effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2026-10-28T20:00:00Z" });
    const e = receiverEnv(fixedConfig({ retention: lapsing }));
    at("2026-10-28T18:10:00Z");
    expect(await send(await delivery("2026-10-28T18:05:00.000Z"), e)).toMatchObject({ status: "committed" });
    const settled = await rollupDump();
    const healthRow = await sql("SELECT * FROM ingest_health");
    const policyRow = await sql("SELECT * FROM retention_state");
    at("2026-10-28T20:30:00Z");
    const refused = await post(await delivery("2026-10-28T20:25:00.000Z"), e);
    expect([refused.status, await refused.json()]).toEqual([403, { code: "retention_unapproved" }]);
    // Nothing changed: not the counters, the dedupe state, the health row or the applied policy.
    expect(JSON.parse(await rollupDump())).toEqual(JSON.parse(settled).map((r: object) => ({ ...r, provisional: true })));
    expect(await count("deliveries")).toBe(1);
    expect(await sql("SELECT * FROM ingest_health")).toEqual(healthRow);
    expect(await sql("SELECT * FROM retention_state")).toEqual(policyRow);
  });
});

describe("W8a revocation", () => {
  const active = () => receiverEnv(fixedConfig());
  const revoked = () => receiverEnv(fixedConfig({ state: "revoked", revocationRef: "SYNTHETIC-REVOCATION-1" }));

  it("purges the tenant's totals, keeps dedupe state, refuses everything while revoked, and re-enrolment cannot recount", async () => {
    at("2026-10-28T18:10:00Z");
    const d1 = await delivery("2026-10-28T18:05:00.000Z", { pair: true });
    const d2 = await delivery("2026-10-28T17:00:00.000Z");
    // Exactly at the future-skew limit (accepted 5 minutes ahead): its bucket (18:15) starts at the
    // clock-rounded revocation time, yet its totals are purged like the others and must not be acked.
    const d3 = await delivery("2026-10-28T18:15:00.000Z");
    expect(await send(d1, active())).toMatchObject({ status: "committed" });
    expect(await send(d2, active())).toMatchObject({ status: "committed" });
    expect(await send(d3, active())).toMatchObject({ status: "committed" });
    expect(await totals()).toMatchObject({ evaluated: 3 });

    // Another tenant is untouched by this tenant's revocation.
    expect(await send(await delivery("2026-10-28T18:05:00.000Z", { event: { source: "playtrek" } }), active(), OTHER, OTHER_KEY)).toMatchObject({ status: "committed" });

    // The revoked configuration, presented by the authenticated tenant, purges its totals and health.
    const gone = await post(d1, revoked());
    expect([gone.status, await gone.json()]).toEqual([403, { code: "retention_unapproved" }]);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await count("rollups")).toBe(0);
    expect(await stub().health()).toMatchObject({ lastIngestAt: null, committed: 0, deduplicated: 0, conflicts: 0 });
    // Dedupe state is deliberately kept; only the bounded tombstone and the policy state are added.
    expect(await count("deliveries")).toBe(3);
    // The rejection boundary covers every purged bucket: the newest one (18:15) ends at 18:30.
    expect(await stub().retention()).toEqual({ state: "revoked", policyRevision: "revoked", revokedFloor: "2026-10-28T18:30:00.000Z" });
    expect((await totals(OTHER)).evaluated).toBe(1);

    // While revoked nothing is accepted, held or new, and nothing is acknowledged.
    expect((await post(d1, revoked())).status).toBe(403);
    expect((await post(await delivery("2026-10-28T18:08:00.000Z"), revoked())).status).toBe(403);
    expect(await count("deliveries")).toBe(3);

    // Re-enrolling does not reset the no-recount boundary.
    // A delivery for the purged period is NOT acknowledged as durably counted, because it is not:
    // the producer keeps it, then records a coverage gap. Its dedupe state is still held, so nothing
    // can recount it. That includes d3, the one accepted at the edge of the future-skew allowance.
    for (const held of [d1, d2, d3]) {
      const refused = await post(held, active());
      expect([refused.status, await refused.json()]).toEqual([422, { code: "stale_occurrence" }]);
      expect((await send(held, active())).kind).toBe("retry");
    }
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect(await count("deliveries")).toBe(3);
    // A new delivery for the purged period is refused (the tombstone), so the totals cannot be rebuilt.
    const rebuilt = await post(await delivery("2026-10-28T18:05:00.000Z"), active());
    expect([rebuilt.status, await rebuilt.json()]).toEqual([422, { code: "stale_occurrence" }]);
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    // New occurrences after the revocation are counted from scratch.
    at("2026-10-28T18:40:00Z");
    expect(await send(await delivery("2026-10-28T18:30:00.000Z"), active())).toMatchObject({ status: "committed" });
    expect(await totals()).toMatchObject({ evaluated: 1, rows: 1 });

    // The tombstone is bounded: it ages out once nothing it guards can still be accepted.
    at("2026-10-30T00:00:00Z");
    await alarm();
    expect((await stub().retention())!.revokedFloor).toBeNull();
    expect(await count("deliveries")).toBe(0);
  });

  it("does not acknowledge a purged delivery accepted at the revocation floor (reviewer scenario)", async () => {
    at("2026-10-28T18:10:00Z");
    const held = await delivery("2026-10-28T18:15:00.000Z");
    expect(await send(held, active())).toMatchObject({ status: "committed" });
    expect((await post(held, revoked())).status).toBe(403);
    expect(await stub().rollups()).toEqual([]);
    const replay = await post(held, active());
    expect([replay.status, await replay.json()]).toEqual([422, { code: "stale_occurrence" }]);
    // A replay is not acknowledged as durable, in any form the producer would accept.
    expect((await send(held, active())).kind).toBe("retry");
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  });

  it("rejects every purged bucket, including the newest one and the one before it, and the exact boundary admits new occurrences", async () => {
    at("2026-10-28T18:10:00Z");
    // Buckets 17:45 (old), 18:00 (open) and 18:15 (future skew), each carrying counts that get purged.
    const held = [
      await delivery("2026-10-28T17:50:00.000Z"),
      await delivery("2026-10-28T18:05:00.000Z", { pair: true }),
      await delivery("2026-10-28T18:14:59.999Z"),
      await delivery("2026-10-28T18:15:00.000Z"),
      await delivery("2026-10-28T18:15:00.001Z", { pair: true }),
      await delivery("2026-10-28T18:15:00.000Z", { event: { modality: "image" } }),
    ];
    for (const b of held) expect(await send(b, active())).toMatchObject({ status: "committed" });
    expect(await totals()).toMatchObject({ evaluated: 6 });
    await post(held[0]!, revoked());
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
    expect((await stub().retention())!.revokedFloor).toBe("2026-10-28T18:30:00.000Z");

    for (const b of held) {
      expect((await post(b, active())).status).toBe(422);
      expect((await send(b, active())).kind).toBe("retry");
    }
    // A NEW delivery for any purged bucket is refused too: it could only rebuild a partial total.
    at("2026-10-28T18:12:00Z");
    for (const iso of ["2026-10-28T17:55:00.000Z", "2026-10-28T18:05:00.000Z", "2026-10-28T18:16:00.000Z"]) {
      expect((await post(await delivery(iso), active())).status, iso).toBe(422);
    }
    expect(await totals()).toEqual({ evaluated: 0, candidate: 0, rows: 0 });

    // The exact boundary: 18:29:59.999 is still a purged bucket; 18:30:00.000 is genuinely new.
    at("2026-10-28T18:26:00Z");
    expect((await post(await delivery("2026-10-28T18:29:59.999Z"), active())).status).toBe(422);
    expect(await send(await delivery("2026-10-28T18:30:00.000Z"), active())).toEqual({ kind: "acked", status: "committed" });
    expect(await totals()).toMatchObject({ evaluated: 1, rows: 1 });
    // The dedupe rows of the purged deliveries were kept throughout, so nothing was erased to make this work.
    expect(await count("deliveries")).toBe(7);
  });

  it("covers purged rollups from before W8a as well, and a repeated revocation never lowers the boundary", async () => {
    at("2026-10-28T18:10:00Z");
    await sql("SELECT 1");
    const bucket = Date.parse("2026-10-28T19:00:00.000Z"); // newer than anything the clock-rounded floor would cover
    await runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec("INSERT INTO rollups_legacy VALUES (?, 'educateos', 'g9_12', 'text', 'rev-a', 3, 1, ?)", bucket, bucket + 900_000 + 86_400_000 * 365);
    });
    await post(await delivery("2026-10-28T18:05:00.000Z"), revoked());
    expect(await count("rollups_legacy")).toBe(0);
    expect((await stub().retention())!.revokedFloor).toBe("2026-10-28T19:15:00.000Z");
    // Revoking again (every request under a revoked configuration does) cannot lower it.
    at("2026-10-28T18:20:00Z");
    await post(await delivery("2026-10-28T18:19:00.000Z"), revoked());
    expect((await stub().retention())!.revokedFloor).toBe("2026-10-28T19:15:00.000Z");
  });

  it("revoking a tenant that never stored anything is harmless and still refuses ingest", async () => {
    at("2026-10-28T18:10:00Z");
    expect((await post(await delivery("2026-10-28T18:05:00.000Z"), revoked())).status).toBe(403);
    expect(await count("rollups")).toBe(0);
    expect((await stub().retention())!.state).toBe("revoked");
  });
});

describe("W8a pre-W8a state and coverage", () => {
  it("migrates a database written before W8a without erasing dedupe state or inventing dimensions", async () => {
    const tenant = "tenant_legacy";
    const bucket = Date.UTC(2026, 9, 28, 17, 0, 0);
    await runInDurableObject(stub(tenant), async (_i, state) => {
      state.storage.sql.exec(`
        DROP TABLE rollups; DROP TABLE rollups_legacy; DROP TABLE deliveries; DROP TABLE ingest_health; DROP TABLE retention_state;
        CREATE TABLE deliveries (delivery_key TEXT PRIMARY KEY, digest TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE rollups (bucket_start INTEGER NOT NULL, source TEXT NOT NULL, grade_band TEXT NOT NULL, modality TEXT NOT NULL,
          producer_revision TEXT NOT NULL, evaluated INTEGER NOT NULL, candidate INTEGER NOT NULL,
          PRIMARY KEY (bucket_start, source, grade_band, modality, producer_revision));
        CREATE TABLE ingest_health (id INTEGER PRIMARY KEY CHECK (id = 1), last_ingest_at INTEGER, committed INTEGER NOT NULL,
          deduplicated INTEGER NOT NULL, conflicts INTEGER NOT NULL);
        INSERT INTO ingest_health VALUES (1, ${bucket}, 5, 2, 1);
      `);
      state.storage.sql.exec("INSERT INTO deliveries VALUES ('held-key', 'held-digest', ?)", Date.now() + 3_600_000);
      state.storage.sql.exec("INSERT INTO rollups VALUES (?, 'educateos', 'g9_12', 'text', 'rev-a', 7, 3)", bucket);

      const migrated = new Store(state, env);
      await state.blockConcurrencyWhile(async () => {});
      // Dedupe state survived untouched; the old counters moved aside; health was reset (it had no policy).
      expect(state.storage.sql.exec("SELECT delivery_key, digest FROM deliveries").toArray()).toEqual([{ delivery_key: "held-key", digest: "held-digest" }]);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM rollups").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM rollups_legacy").one().n).toBe(1);
      expect(state.storage.sql.exec("SELECT committed, deduplicated, conflicts FROM ingest_health").one()).toEqual({ committed: 0, deduplicated: 0, conflicts: 0 });
      // A migrated row is readable but explicitly without local time, revision or completeness: nothing invented.
      expect(await migrated.rollups()).toEqual([{
        bucketStart: new Date(bucket).toISOString(), source: "educateos", gradeBand: "g9_12", modality: "text", producerRevision: "rev-a",
        evaluated: 7, candidate: 3, time: null, revision: null, lateRevisions: null, provisional: null, completeness: "unavailable",
      }]);
      // Revocation removes it with every other rollup, and still keeps dedupe state.
      await migrated.revoke();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM rollups_legacy").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM deliveries").one().n).toBe(1);
      // Migrating again is a no-op (idempotent), whatever the table's current shape.
      new Store(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM deliveries").one().n).toBe(1);
    });
  });

  it("keeps coverage unavailable: a healthy receiver with a silent producer is not coverage, and a missing bucket is not zero", async () => {
    at("2026-10-28T18:10:00Z");
    // Nothing has ever been received: no rows, and no claim of coverage or of a verified zero.
    expect(await stub().rollups()).toEqual([]);
    expect(await stub().health()).toMatchObject({ committed: 0, producerCoverage: "unavailable" });
    // A collector delivering ordinary traffic from one hour still says nothing about the rest.
    await send(await delivery("2026-10-28T17:05:00.000Z"), receiverEnv(fixedConfig()));
    const health = await stub().health();
    expect(health).toMatchObject({ committed: 1, producerCoverage: "unavailable" });
    const rows = await stub().rollups();
    expect(rows.map((r) => r.bucketStart)).toEqual(["2026-10-28T17:00:00.000Z"]); // other quarter-hours: no row, not a zero row
    expect(rows.every((r) => r.completeness === "unavailable")).toBe(true);
    // Time passes with a healthy receiver and no producer traffic: still no manufactured buckets.
    at("2026-10-28T20:00:00Z");
    expect((await stub().rollups()).map((r) => r.bucketStart)).toEqual(["2026-10-28T17:00:00.000Z"]);
    expect((await stub().health()).producerCoverage).toBe("unavailable");
  });

  it("leaves the v1 validate-and-discard receiver and its grants unchanged by any of this", async () => {
    // v1 never requires, reads or is enabled by the v2 time/retention configuration.
    const V1_KEY = "synthetic-v1-receiver-key-0123456789-abcdefghi";
    const { signedTelemetryRequest } = await import("@gmacko/hall-monitor-telemetry-sink");
    const v1Env = { ...env, HM_TELEMETRY_ACCEPT: "validate_only", HM_TELEMETRY_TENANTS: JSON.stringify({ [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: V1_KEY } }) } as never;
    const request = await signedTelemetryRequest(TENANT, V1_KEY, { schemaVersion: 1, events: [(await delivery(new Date(Date.now() - 60_000).toISOString())).delivery.events[0]!] });
    const response = await handleTelemetry(request, v1Env);
    expect([response.status, await response.json()]).toEqual([202, { code: "validated_not_persisted", accepted: 1, persisted: false }]);
    await expectNothingStored();
    expect(newDeliveryId()).toMatch(/^dlv_/);
    expect(GRANTS).toContain(TENANT);
    expect(FIXED_POLICY.policyRevision).toBe("synthetic-policy-1");
  });
});
