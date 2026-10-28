import { parseTelemetryReceiverTenantsV2 } from "@gmacko/hall-monitor-telemetry-contracts";
import { describe, expect, it } from "vitest";
import { parseTenantConfigsV2, resolveTenantConfigsV2 } from "../src/tenant-config.ts";
import { resolveInterval } from "../src/time.ts";
import { configDoc, intervalDoc, policyDoc } from "./fixtures.ts";

// Every identifier and duration here is fictional test data, not an approval or a real district.
const KEY = "synthetic-config-test-key-0123456789-abcdefghij";
const GRANTS = parseTelemetryReceiverTenantsV2(JSON.stringify({
  tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevisions: ["rev-a", "rev-b"] },
  tenant_playtrek: { source: "playtrek", gradeBands: ["g9_12"], signingKey: KEY + "x", producerRevisions: ["rev-a"] },
}))!;
const now = Date.UTC(2026, 9, 28, 18, 0, 0);
const one = (over: Record<string, unknown> = {}) => JSON.stringify({ tenant_educateos: configDoc(over, now) });
const withInterval = (over: Record<string, unknown>) => one({ intervals: [intervalDoc(over, now)] });
const span = (from: string, to: string, kind = "holiday") => ({ from, to, kind });

describe("tenant configuration (W8a)", () => {
  it("accepts a complete configuration and exposes sorted, typed intervals", () => {
    const a = intervalDoc({ calendarRevision: "cal-1" }, now);
    const from2 = Date.parse(a.to);
    const b = intervalDoc({ from: new Date(from2).toISOString(), to: new Date(from2 + 86_400_000).toISOString(), calendarRevision: "cal-2", timeZone: "America/Phoenix" }, now);
    const parsed = parseTenantConfigsV2(one({ intervals: [b, a] }))!.get("tenant_educateos")!;
    expect(parsed.intervals.map((i) => i.calendarRevision)).toEqual(["cal-1", "cal-2"]);
    expect(parsed.state).toBe("active");
    expect(parsed.revocationRef).toBeNull();
    expect(parsed.retention.policyRevision).toBe("synthetic-policy-1");
    // The occurrence selects its effective interval; a gap or an out-of-range instant selects none.
    expect(resolveInterval(parsed.intervals, from2 - 1)?.calendarRevision).toBe("cal-1");
    expect(resolveInterval(parsed.intervals, from2)?.calendarRevision).toBe("cal-2");
    expect(resolveInterval(parsed.intervals, from2 + 86_400_000)).toBeNull();
    expect(resolveInterval(parsed.intervals, Date.parse(a.from) - 1)).toBeNull();
  });

  it("never partially authorizes: absent, empty, oversized and malformed settings are null", () => {
    for (const bad of [undefined, "", "{", "[]", "{}", "null", "1", JSON.stringify({ tenant_educateos: null }), "x".repeat(512 * 1024 + 1)]) {
      expect(parseTenantConfigsV2(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });

  it("rejects unknown fields at every level", () => {
    for (const bad of [
      one({ extra: 1 }),
      one({ tenant: "tenant_educateos" }),
      one({ retention: policyDoc(now, { extra: 1 }) }),
      withInterval({ extra: 1 }),
      withInterval({ calendar: [{ ...span("2026-11-26", "2026-11-26"), label: "Thanksgiving" }] }),
    ]) expect(parseTenantConfigsV2(bad)).toBeNull();
  });

  it("requires every field: schema version, revision, source, state, retention, intervals", () => {
    for (const key of ["schemaVersion", "configRevision", "source", "state", "retention", "intervals"]) {
      const doc = configDoc({}, now);
      delete doc[key];
      expect(parseTenantConfigsV2(JSON.stringify({ tenant_educateos: doc })), key).toBeNull();
    }
    expect(parseTenantConfigsV2(one({ schemaVersion: 2 }))).toBeNull();
    expect(parseTenantConfigsV2(one({ source: "unknown_product" }))).toBeNull();
    expect(parseTenantConfigsV2(one({ configRevision: "has space" }))).toBeNull();
    expect(parseTenantConfigsV2(one({ intervals: [] }))).toBeNull();
  });

  it("rejects an invalid or unsupported time zone", () => {
    for (const timeZone of ["Mars/Phobos", "+05:00", "-04:00", "EST5EDT", "America/", "/Detroit", "america detroit", "", 5, null, "America/" + "x".repeat(80)]) {
      expect(parseTenantConfigsV2(withInterval({ timeZone: timeZone as string })), String(timeZone)).toBeNull();
    }
    for (const timeZone of ["America/Detroit", "America/Los_Angeles", "America/Phoenix", "Pacific/Honolulu", "Asia/Kolkata", "Asia/Kathmandu", "UTC", "America/Argentina/Buenos_Aires"]) {
      expect(parseTenantConfigsV2(withInterval({ timeZone })), timeZone).not.toBeNull();
    }
  });

  it("rejects invalid dates, instants and unsupported precision at interval boundaries", () => {
    const base = intervalDoc({}, now);
    for (const from of ["2026-02-30T00:00:00Z", "2026-10-01", "2026-10-01T00:00:00+00:00", "2026-10-01T00:07:00Z", "2026-10-01T00:00:30Z", "2026-10-01T00:00:00.500Z", 5, null]) {
      expect(parseTenantConfigsV2(withInterval({ from: from as string })), String(from)).toBeNull();
    }
    expect(parseTenantConfigsV2(withInterval({ to: "2026-10-01T00:10:00Z" }))).toBeNull();
    // Half-open and ordered: empty and reversed intervals are invalid.
    expect(parseTenantConfigsV2(withInterval({ to: base.from }))).toBeNull();
    // Bounded length.
    expect(parseTenantConfigsV2(withInterval({ to: new Date(Date.parse(base.from) + 801 * 86_400_000).toISOString() }))).toBeNull();
  });

  it("rejects overlapping intervals but allows a gap, and requires distinct calendar revisions", () => {
    const a = intervalDoc({ calendarRevision: "cal-1" }, now);
    const start = Date.parse(a.to);
    const at = (ms: number) => new Date(ms).toISOString();
    const adjacent = intervalDoc({ from: at(start), to: at(start + 86_400_000), calendarRevision: "cal-2" }, now);
    const overlapping = intervalDoc({ from: at(start - 900_000), to: at(start + 86_400_000), calendarRevision: "cal-2" }, now);
    const gapped = intervalDoc({ from: at(start + 900_000), to: at(start + 86_400_000), calendarRevision: "cal-2" }, now);
    expect(parseTenantConfigsV2(one({ intervals: [a, adjacent] }))).not.toBeNull();
    expect(parseTenantConfigsV2(one({ intervals: [a, overlapping] }))).toBeNull();
    const withGap = parseTenantConfigsV2(one({ intervals: [a, gapped] }))!.get("tenant_educateos")!;
    expect(resolveInterval(withGap.intervals, start)).toBeNull(); // an ingest inside the gap resolves to nothing
    expect(parseTenantConfigsV2(one({ intervals: [a, { ...adjacent, calendarRevision: "cal-1" }] }))).toBeNull();
  });

  it("classifies calendar dates explicitly: no overlap, valid dates, bounded, known kinds only", () => {
    const ok = [span("2026-11-26", "2026-11-27"), span("2026-11-28", "2026-11-29", "weekend")];
    expect(parseTenantConfigsV2(withInterval({ calendar: ok }))).not.toBeNull();
    for (const calendar of [
      [span("2026-11-26", "2026-11-28"), span("2026-11-28", "2026-11-29", "weekend")],
      [span("2026-11-27", "2026-11-26")],
      [span("2026-02-30", "2026-03-01")],
      [span("2026-11-26", "2026-11-26", "vacation")],
      [span("11/26/2026", "11/26/2026")],
      [{ from: "2026-11-26", to: "2026-11-26" }],
    ]) expect(parseTenantConfigsV2(withInterval({ calendar: calendar as never }))).toBeNull();
    // Unclassified dates are left out, never defaulted: their kind is "unknown".
    const parsed = parseTenantConfigsV2(withInterval({ calendar: ok }))!.get("tenant_educateos")!;
    expect(parsed.intervals[0]!.calendar).toHaveLength(2);
  });

  it("bounds every list: 16 intervals, 400 calendar spans, 16 revisions", () => {
    const base = Date.parse(intervalDoc({}, now).from);
    const day = 86_400_000;
    const many = (n: number) => Array.from({ length: n }, (_, i) => intervalDoc({
      from: new Date(base + i * day).toISOString(), to: new Date(base + (i + 1) * day).toISOString(), calendarRevision: `cal-${i}`,
    }, now));
    expect(parseTenantConfigsV2(one({ intervals: many(16) }))).not.toBeNull();
    expect(parseTenantConfigsV2(one({ intervals: many(17) }))).toBeNull();
    const spans = (n: number) => Array.from({ length: n }, (_, i) => {
      const date = new Date(Date.UTC(2026, 0, 1) + i * day).toISOString().slice(0, 10);
      return span(date, date);
    });
    expect(parseTenantConfigsV2(withInterval({ calendar: spans(400) }))).not.toBeNull();
    expect(parseTenantConfigsV2(withInterval({ calendar: spans(401) }))).toBeNull();
    const revisions = (n: number) => Array.from({ length: n }, (_, i) => `rev-${i}`);
    expect(parseTenantConfigsV2(withInterval({ producerRevisions: revisions(16) }))).not.toBeNull();
    expect(parseTenantConfigsV2(withInterval({ producerRevisions: revisions(17) }))).toBeNull();
    expect(parseTenantConfigsV2(withInterval({ producerRevisions: [] }))).toBeNull();
    expect(parseTenantConfigsV2(withInterval({ producerRevisions: ["rev-a", "rev-a"] }))).toBeNull();
  });

  it("rejects an unusable retention policy inside the configuration (no silent default)", () => {
    for (const retention of [undefined, null, {}, policyDoc(now, { gapSeconds: 1 }), policyDoc(now, { approvalRef: "" }), policyDoc(now, { dedupeSeconds: 60 })]) {
      expect(parseTenantConfigsV2(one({ retention })), JSON.stringify(retention)).toBeNull();
    }
  });

  it("requires a revocation reference exactly when the tenant is revoked", () => {
    expect(parseTenantConfigsV2(one({ state: "revoked" }))).toBeNull();
    expect(parseTenantConfigsV2(one({ state: "revoked", revocationRef: "" }))).toBeNull();
    expect(parseTenantConfigsV2(one({ state: "active", revocationRef: "SYNTHETIC-REVOCATION" }))).toBeNull();
    expect(parseTenantConfigsV2(one({ state: "suspended" }))).toBeNull();
    const revoked = parseTenantConfigsV2(one({ state: "revoked", revocationRef: "SYNTHETIC-REVOCATION" }))!.get("tenant_educateos")!;
    expect(revoked).toMatchObject({ state: "revoked", revocationRef: "SYNTHETIC-REVOCATION" });
  });

  it("makes a configuration revision name exactly one tenant's configuration", () => {
    const both = (a: string, b: string) => JSON.stringify({
      tenant_educateos: configDoc({ configRevision: a }, now),
      tenant_playtrek: configDoc({ configRevision: b, source: "playtrek" }, now),
    });
    expect(parseTenantConfigsV2(both("cfg-1", "cfg-2"))).not.toBeNull();
    expect(parseTenantConfigsV2(both("cfg-1", "cfg-1"))).toBeNull();
  });

  it("refuses configuration that conflicts with the tenant grants", () => {
    expect(resolveTenantConfigsV2(one(), GRANTS)).not.toBeNull();
    // Source differs from the grant.
    expect(resolveTenantConfigsV2(one({ source: "playtrek" }), GRANTS)).toBeNull();
    // An interval approves a producer revision the grant does not.
    expect(resolveTenantConfigsV2(withInterval({ producerRevisions: ["rev-a", "rev-z"] }), GRANTS)).toBeNull();
    // A configured tenant with no grant.
    expect(resolveTenantConfigsV2(JSON.stringify({ tenant_nobody: configDoc({}, now) }), GRANTS)).toBeNull();
    // A grant without configuration is not a conflict here; that tenant simply has no configuration.
    expect(resolveTenantConfigsV2(one(), GRANTS)!.has("tenant_playtrek")).toBe(false);
  });
});
