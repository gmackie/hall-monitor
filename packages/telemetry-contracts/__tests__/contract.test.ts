import { describe, expect, it } from "vitest";
import {
  parseTelemetryBatch, parseTelemetryTenants, grantAllowsBatch, isT1EvaluationBatch,
  type TemporalMetricEvent,
} from "../src/index.ts";

const KEY = "synthetic-only-signing-key-please-replace-xxxxxxxxxxx";
const sample: TemporalMetricEvent = {
  schemaVersion: 1, occurredAt: "2026-10-28T18:00:00Z",
  kind: "content_evaluated", category: "none", priority: "routine",
  modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown",
};

describe("telemetry strict input boundary", () => {
  it("accepts only a fixed v1 batch", () => {
    expect(parseTelemetryBatch({ schemaVersion: 1, events: [sample] }).events).toEqual([sample]);
    for (const payload of [
      { schemaVersion: 1, events: [], extra: 1 },
      { schemaVersion: 1, events: [] },
      { schemaVersion: 2, events: [sample] },
      { schemaVersion: 1, events: Array.from({ length: 17 }, () => sample) },
      { schemaVersion: 1, events: [{ ...sample, message: "classmate's secret" }] },
      { schemaVersion: 1, events: [{ ...sample, studentId: "student_123" }] },
      { schemaVersion: 1, events: [{ ...sample, category: "student-alex" }] },
    ]) expect(() => parseTelemetryBatch(payload)).toThrow();
  });

  it("accepts only coarse T1 evaluation counts, never case/review or urgency claims", () => {
    const v1 = { schemaVersion: 1 as const, events: [sample] };
    expect(isT1EvaluationBatch(v1)).toBe(true);
    expect(isT1EvaluationBatch({ ...v1, events: [sample, { ...sample, kind: "candidate_flagged", category: "other" }] })).toBe(true);
    for (const events of [
      [{ ...sample, kind: "report_received" }],
      [{ ...sample, priority: "urgent" }],
      [{ ...sample, category: "harassment" }],
      [{ ...sample, calendarKind: "instructional" }],
      [{ ...sample, kind: "candidate_flagged", category: "other" }],
      [sample, { ...sample, kind: "candidate_flagged", category: "self_harm" }],
      [sample, { ...sample, kind: "candidate_flagged", category: "other", gradeBand: "g6_8" }],
    ] as unknown[][]) {
      expect(isT1EvaluationBatch(parseTelemetryBatch({ schemaVersion: 1, events }))).toBe(false);
    }
  });

  it("requires explicit, strictly typed per-tenant scope and key", () => {
    const good = JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } });
    const tenants = parseTelemetryTenants(good)!;
    expect(tenants.size).toBe(1);
    expect(grantAllowsBatch(tenants.get("tenant_educateos")!, { schemaVersion: 1, events: [sample] })).toBe(true);
    expect(grantAllowsBatch(tenants.get("tenant_educateos")!, { schemaVersion: 1, events: [{ ...sample, gradeBand: "g6_8" }] })).toBe(false);
    expect(grantAllowsBatch(tenants.get("tenant_educateos")!, { schemaVersion: 1, events: [{ ...sample, source: "playtrek" }] })).toBe(false);
  });

  it("rejects omitted, wildcard, malformed, extra-field and weak key grants", () => {
    const wrong = [
      undefined, "", "{}", '{"*":{"source":"educateos","gradeBands":["g9_12"],"signingKey":"' + KEY + '"}}',
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: "short" } }),
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12", "g9_12"], signingKey: KEY } }),
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: [], signingKey: KEY } }),
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, allowAny: true } }),
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["student_alex"], signingKey: KEY } }),
    ];
    for (const value of wrong) expect(parseTelemetryTenants(value)).toBeNull();
  });
});
