import { describe, expect, it, vi } from "vitest";
import { handleTelemetry } from "../src/index.ts";
import { signedTelemetryRequest } from "@gmacko/hall-monitor-telemetry-sink";
import type { TemporalMetricEvent } from "@gmacko/hall-monitor-telemetry-contracts";

const KEY = "synthetic-collector-hmac-secret-abcdefgh12345678";
const rawGrant = JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } });
const active = { HM_TELEMETRY_ACCEPT: "validate_only", HM_TELEMETRY_TENANTS: rawGrant };
const event: TemporalMetricEvent = {
  schemaVersion: 1, occurredAt: "2026-10-28T18:00:00Z",
  kind: "content_evaluated", category: "none", priority: "routine",
  modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown",
};
const batch = { schemaVersion: 1 as const, events: [event] };
const sign = (b: unknown = batch, tenant = "tenant_educateos", key = KEY) =>
  signedTelemetryRequest(tenant, key, b);

describe("internal-only validate-and-discard collector", () => {
  it("remains disabled by default and returns no content", async () => {
    const response = await handleTelemetry(await sign(), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "disabled" });
  });
  it("accepts an authorized request, explicitly reporting NO persistence", async () => {
    const spy = vi.spyOn(console, "log");
    const response = await handleTelemetry(await sign(), active);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ code: "validated_not_persisted", accepted: 1, persisted: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("denies missing signature, wrong key, source/grade and cross-tenant events", async () => {
    const unauthenticated = new Request("https://telemetry.internal/internal/v1/telemetry", { method: "POST", body: "{}" });
    expect((await handleTelemetry(unauthenticated, active)).status).toBe(401);
    expect((await handleTelemetry(await sign(batch, "tenant_other"), active)).status).toBe(403);
    expect((await handleTelemetry(await sign(batch, "tenant_educateos", "wrong-key-not-valid-for-authorized-tenant"), active)).status).toBe(401);
    expect((await handleTelemetry(await sign({ schemaVersion: 1, events: [{ ...event, source: "playtrek" }] }), active)).status).toBe(403);
    expect((await handleTelemetry(await sign({ schemaVersion: 1, events: [{ ...event, gradeBand: "g6_8" }] }), active)).status).toBe(403);
  });
  it("rejects case/report spoofing and sensitive event categories, even when signed by an approved tenant", async () => {
    const forged = [
      { ...event, kind: "incident_opened" },
      { ...event, kind: "report_received" },
      { ...event, priority: "urgent" },
      { ...event, calendarKind: "instructional" },
      { ...event, category: "self_harm" },
    ];
    for (const bad of forged) {
      const request = await sign({ schemaVersion: 1, events: [bad] });
      expect((await handleTelemetry(request, active)).status).toBe(403);
    }
    const outOfSequence = await sign({ schemaVersion: 1, events: [{ ...event, kind: "candidate_flagged", category: "other" }] });
    expect((await handleTelemetry(outOfSequence, active)).status).toBe(403);
  });

  it("rejects unexpected message fields even when signed", async () => {
    await expect(sign({ schemaVersion: 1, events: [{ ...event, studentId: "student_123" }] })).rejects.toThrow();
  });
  it("denies malformed configuration and has no public information endpoint", async () => {
    expect((await handleTelemetry(await sign(), { ...active, HM_TELEMETRY_TENANTS: "{}" })).status).toBe(503);
    const req = new Request("https://telemetry.internal/health");
    expect((await handleTelemetry(req, active)).status).toBe(404);
  });
});
