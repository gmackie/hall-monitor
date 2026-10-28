import { describe, expect, it } from "vitest";
import {
  TELEMETRY_V2_MAX_FUTURE_SKEW_MS, TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS, TELEMETRY_V2_MAX_RETENTION_SECONDS,
  TELEMETRY_V2_MIN_DEDUPE_SECONDS, TELEMETRY_V2_MIN_HEALTH_SECONDS,
  parseTelemetryProducerRetentionV2, parseTelemetryRetentionPolicy, parseUtcInstant, retentionPolicyActive,
} from "../src/index.ts";

// Every value is FICTIONAL. SYNTHETIC-TEST-ONLY-NOT-AN-APPROVAL is not an approval and these
// durations are not a recommended or approved retention.
const doc = (over: Record<string, unknown> = {}) => ({
  policyRevision: "synthetic-policy-1",
  approvalRef: "SYNTHETIC-TEST-ONLY-NOT-AN-APPROVAL",
  effectiveFrom: "2026-10-01T00:00:00Z",
  approvedUntil: "2027-10-01T00:00:00Z",
  dedupeSeconds: 90_000,
  rollupSeconds: 200_000,
  healthSeconds: 7_200,
  gapSeconds: 300_000,
  ...over,
});

describe("retention policy schema (W8a)", () => {
  it("accepts a complete, consistent policy and converts it exactly", () => {
    expect(parseTelemetryRetentionPolicy(doc())).toEqual({
      policyRevision: "synthetic-policy-1", approvalRef: "SYNTHETIC-TEST-ONLY-NOT-AN-APPROVAL",
      effectiveFromMs: Date.UTC(2026, 9, 1), approvedUntilMs: Date.UTC(2027, 9, 1),
      dedupeSeconds: 90_000, rollupSeconds: 200_000, healthSeconds: 7_200, gapSeconds: 300_000,
    });
  });

  it("has no defaults: every field is required and unknown fields invalidate the policy", () => {
    expect(parseTelemetryRetentionPolicy(undefined)).toBeNull();
    expect(parseTelemetryRetentionPolicy(null)).toBeNull();
    expect(parseTelemetryRetentionPolicy([])).toBeNull();
    expect(parseTelemetryRetentionPolicy({})).toBeNull();
    for (const key of Object.keys(doc())) {
      const missing: Record<string, unknown> = doc();
      delete missing[key];
      expect(parseTelemetryRetentionPolicy(missing), `missing ${key}`).toBeNull();
    }
    expect(parseTelemetryRetentionPolicy(doc({ extra: 1 }))).toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ tenant: "tenant_educateos" }))).toBeNull();
  });

  it("covers the whole accepted occurrence horizon: dedupe state can never be shorter than it", () => {
    const horizon = Math.ceil((TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + TELEMETRY_V2_MAX_FUTURE_SKEW_MS) / 1000);
    expect(TELEMETRY_V2_MIN_DEDUPE_SECONDS).toBe(horizon);
    expect(parseTelemetryRetentionPolicy(doc({ dedupeSeconds: horizon, rollupSeconds: horizon, gapSeconds: horizon }))).not.toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ dedupeSeconds: horizon - 1 }))).toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ dedupeSeconds: 12 * 3600 }))).toBeNull();
    // The rollup and gap TTLs share the floor, so an expired rollup cannot be rebuilt by replay.
    expect(parseTelemetryRetentionPolicy(doc({ rollupSeconds: horizon - 1, dedupeSeconds: horizon - 1 }))).toBeNull();
  });

  it("is internally consistent: rollups outlive dedupe state, and gap evidence outlives rollups", () => {
    expect(parseTelemetryRetentionPolicy(doc({ dedupeSeconds: 100_000, rollupSeconds: 99_999 }))).toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ rollupSeconds: 100_000, dedupeSeconds: 100_000, gapSeconds: 99_999 }))).toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ rollupSeconds: 100_000, dedupeSeconds: 100_000, gapSeconds: 100_000 }))).not.toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ healthSeconds: TELEMETRY_V2_MIN_HEALTH_SECONDS - 1 }))).toBeNull();
  });

  it("rejects non-integer, non-number, negative, zero and unbounded durations", () => {
    for (const bad of [1.5, "90000", null, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, TELEMETRY_V2_MAX_RETENTION_SECONDS + 1]) {
      for (const key of ["dedupeSeconds", "rollupSeconds", "healthSeconds", "gapSeconds"]) {
        expect(parseTelemetryRetentionPolicy(doc({ [key]: bad })), `${key}=${String(bad)}`).toBeNull();
      }
    }
  });

  it("requires explicit UTC instants, a real calendar date, and an approval window that is forward", () => {
    for (const bad of ["2026-10-01", "2026-10-01T00:00:00", "2026-10-01T00:00:00+00:00", "2026-10-01T00:00:00-04:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", 1_790_000_000_000, null]) {
      expect(parseTelemetryRetentionPolicy(doc({ effectiveFrom: bad })), String(bad)).toBeNull();
      expect(parseTelemetryRetentionPolicy(doc({ approvedUntil: bad })), String(bad)).toBeNull();
    }
    expect(parseTelemetryRetentionPolicy(doc({ approvedUntil: "2026-10-01T00:00:00Z" }))).toBeNull();
    expect(parseTelemetryRetentionPolicy(doc({ approvedUntil: "2026-09-01T00:00:00Z" }))).toBeNull();
    expect(parseUtcInstant("2028-02-29T12:00:00.5Z")).toBe(Date.UTC(2028, 1, 29, 12, 0, 0, 500));
    expect(parseUtcInstant("2027-02-29T12:00:00Z")).toBeNull();
  });

  it("requires an opaque policy revision and a bounded approval reference", () => {
    for (const bad of ["", "-lead", "has space", "a".repeat(65), 1, null]) {
      expect(parseTelemetryRetentionPolicy(doc({ policyRevision: bad })), String(bad)).toBeNull();
    }
    for (const bad of ["", " lead", "x".repeat(129), "bad\nref", "emoji-😀", 1, null]) {
      expect(parseTelemetryRetentionPolicy(doc({ approvalRef: bad })), String(bad)).toBeNull();
    }
  });

  it("is in force only inside [effectiveFrom, approvedUntil)", () => {
    const policy = parseTelemetryRetentionPolicy(doc())!;
    expect(retentionPolicyActive(policy, policy.effectiveFromMs - 1)).toBe(false);
    expect(retentionPolicyActive(policy, policy.effectiveFromMs)).toBe(true);
    expect(retentionPolicyActive(policy, policy.approvedUntilMs - 1)).toBe(true);
    expect(retentionPolicyActive(policy, policy.approvedUntilMs)).toBe(false);
  });

  it("parses per-tenant producer policies strictly: one bad entry or an unusable setting disables all", () => {
    const good = JSON.stringify({ tenant_educateos: doc(), tenant_playtrek: doc({ policyRevision: "p2" }) });
    expect([...parseTelemetryProducerRetentionV2(good)!.keys()]).toEqual(["tenant_educateos", "tenant_playtrek"]);
    for (const bad of [
      undefined, "", "{", "[]", "{}", "null",
      JSON.stringify({ tenant_educateos: doc({ gapSeconds: 1 }) }),
      JSON.stringify({ tenant_educateos: doc(), tenant_playtrek: { ...doc(), extra: true } }),
      JSON.stringify({ "bad tenant!": doc() }),
      JSON.stringify({ tenant_educateos: "policy" }),
      "x".repeat(64 * 1024 + 1),
    ]) expect(parseTelemetryProducerRetentionV2(bad), String(bad).slice(0, 40)).toBeNull();
  });
});
