import { describe, expect, it } from "vitest";
import { parseTelemetryRetentionPolicy, TELEMETRY_V2_MAX_RETENTION_SECONDS, TELEMETRY_V2_MIN_DEDUPE_SECONDS } from "@gmacko/hall-monitor-telemetry-contracts";
import { parseCoverageRetentionPolicy } from "../src/index.ts";
import { policy } from "./fixtures.ts";

describe("experimental coverage retention admission", () => {
  it("accepts the ninth key only in the experimental parser", () => {
    expect(parseCoverageRetentionPolicy(policy())).toMatchObject({ coverageSeconds: 270_000 });
    expect(parseTelemetryRetentionPolicy(policy())).toBeNull();
    const { coverageSeconds: _coverage, ...old } = policy();
    expect(parseTelemetryRetentionPolicy(old)).not.toBeNull();
    expect(parseCoverageRetentionPolicy(old)).toBeNull();
  });

  it.each(Object.keys(policy()))("requires the explicit %s field", (key) => {
    const p: Record<string, unknown> = policy();
    delete p[key];
    expect(parseCoverageRetentionPolicy(p)).toBeNull();
  });

  it.each([null, [], "{}", 1, true, { ...policy(), surprise: true }])("rejects malformed or additional fields: %j", (raw) => {
    expect(parseCoverageRetentionPolicy(raw)).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, "270000", true, null, TELEMETRY_V2_MAX_RETENTION_SECONDS + 1])("rejects coverage duration %s", (coverageSeconds) => {
    expect(parseCoverageRetentionPolicy({ ...policy(), coverageSeconds })).toBeNull();
  });

  it.each([
    { dedupeSeconds: 200_000 }, { coverageSeconds: 100_000 }, { coverageSeconds: 400_000 },
    { effectiveFrom: "2026-02-30T00:00:00Z" }, { approvedUntil: "2025-01-01T00:00:00Z" },
    { effectiveFrom: "2026-01-01T00:00:00+00:00" }, { healthSeconds: NaN },
  ])("rejects invalid base fields and ordering %j", (over) => {
    expect(parseCoverageRetentionPolicy({ ...policy(), ...over })).toBeNull();
  });

  it.each([TELEMETRY_V2_MIN_DEDUPE_SECONDS, TELEMETRY_V2_MAX_RETENTION_SECONDS])("accepts equality at the duration boundary %s", (seconds) => {
    expect(parseCoverageRetentionPolicy({ ...policy(), dedupeSeconds: seconds, rollupSeconds: seconds, coverageSeconds: seconds, gapSeconds: seconds })).not.toBeNull();
  });
});
