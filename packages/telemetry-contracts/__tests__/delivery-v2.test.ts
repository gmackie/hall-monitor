import { describe, expect, it } from "vitest";
import {
  buildTelemetryDeliveryV2, newDeliveryId, parseTelemetryAckV2, parseTelemetryDeliveryV2,
  parseTelemetryProducerTenantsV2, parseTelemetryReceiverTenantsV2, parseTelemetryTenants,
  type TemporalMetricEvent,
} from "../src/index.ts";

const KEY = "synthetic-v2-contract-signing-key-0123456789-abc";
const evaluated: TemporalMetricEvent = {
  schemaVersion: 1, occurredAt: "2026-10-28T18:00:00.123Z",
  kind: "content_evaluated", category: "none", priority: "routine",
  modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown",
};
const candidate: TemporalMetricEvent = { ...evaluated, kind: "candidate_flagged", category: "other" };
const envelope = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 2, deliveryId: newDeliveryId(), producerRevision: "rev-1", events: [evaluated], ...over,
});

describe("v2 delivery envelope", () => {
  it("accepts exactly an evaluation or an evaluation + matching candidate pair", () => {
    expect(parseTelemetryDeliveryV2(envelope()).events).toHaveLength(1);
    expect(parseTelemetryDeliveryV2(envelope({ events: [evaluated, candidate] })).events).toHaveLength(2);
  });

  it("makes the pair indivisible: no lone candidate, no mismatched or extra half", () => {
    for (const events of [
      [candidate],
      [candidate, evaluated],
      [evaluated, evaluated],
      [evaluated, { ...candidate, occurredAt: "2026-10-28T18:00:01.000Z" }],
      [evaluated, { ...candidate, gradeBand: "g6_8" }],
      [evaluated, { ...candidate, source: "playtrek" }],
      [evaluated, candidate, candidate],
      [{ ...evaluated, kind: "report_received" }],
      [{ ...evaluated, priority: "urgent" }],
      [{ ...evaluated, category: "self_harm" }],
      [],
    ]) expect(() => parseTelemetryDeliveryV2(envelope({ events })), JSON.stringify(events)).toThrow();
  });

  it("is strict about fields, version, ID and revision, and carries no tenant or source identifier", () => {
    for (const bad of [
      envelope({ schemaVersion: 1 }),
      envelope({ deliveryId: "dlv_short" }),
      envelope({ deliveryId: "eval_" + "a".repeat(32) }),
      envelope({ deliveryId: "dlv_" + "A".repeat(32) }),
      envelope({ producerRevision: "" }),
      envelope({ producerRevision: "has space" }),
      envelope({ producerRevision: "x".repeat(65) }),
      envelope({ tenant: "tenant_educateos" }),
      envelope({ requestId: "req_1" }),
      { ...envelope(), events: undefined },
      { schemaVersion: 2, deliveryId: newDeliveryId(), events: [evaluated] },
      envelope({ events: [{ ...evaluated, studentId: "student_1" }] }),
      null, [], "text",
    ]) expect(() => parseTelemetryDeliveryV2(bad)).toThrow();
  });

  it("generates opaque random IDs, not derived from anything", () => {
    const ids = new Set(Array.from({ length: 200 }, newDeliveryId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^dlv_[0-9a-f]{32}$/);
  });

  it("builds stable bytes whose digest changes with any change in content", async () => {
    const id = newDeliveryId();
    const a = await buildTelemetryDeliveryV2({ deliveryId: id, producerRevision: "rev-1", events: [evaluated] });
    const b = await buildTelemetryDeliveryV2({ deliveryId: id, producerRevision: "rev-1", events: [evaluated] });
    expect(a.payload).toBe(b.payload);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    const other = await buildTelemetryDeliveryV2({ deliveryId: id, producerRevision: "rev-2", events: [evaluated] });
    expect(other.digest).not.toBe(a.digest);
    expect(a.payload).not.toMatch(/tenant|student|request|message/i);
  });
});

describe("v2 acknowledgment", () => {
  const good = { schemaVersion: 2, status: "committed", deliveryId: "dlv_" + "a".repeat(32), digest: "b".repeat(64), persisted: true, mac: "c".repeat(64) };

  it("parses only the exact durable shape", () => {
    expect(parseTelemetryAckV2(JSON.stringify(good)).persisted).toBe(true);
    expect(parseTelemetryAckV2(JSON.stringify({ ...good, status: "deduplicated" })).status).toBe("deduplicated");
    for (const bad of [
      { ...good, persisted: false },
      { ...good, persisted: "true" },
      { ...good, status: "accepted" },
      { ...good, status: "validated_not_persisted" },
      { ...good, schemaVersion: 1 },
      { ...good, deliveryId: "eval_x" },
      { ...good, digest: "short" },
      { ...good, mac: undefined },
      { ...good, extra: 1 },
      { code: "validated_not_persisted", accepted: 1, persisted: false },
    ]) expect(() => parseTelemetryAckV2(JSON.stringify(bad))).toThrow();
    expect(() => parseTelemetryAckV2("not json")).toThrow();
  });
});

describe("v2 enrolment is separate from v1", () => {
  const producer = (extra: Record<string, unknown> = {}) => JSON.stringify({
    tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevision: "rev-1", ...extra },
  });

  it("requires an explicit, valid producer revision per tenant", () => {
    expect(parseTelemetryProducerTenantsV2(producer())?.get("tenant_educateos")?.producerRevision).toBe("rev-1");
    for (const bad of [
      producer({ producerRevision: undefined }),
      producer({ producerRevision: "bad rev" }),
      producer({ producerRevision: 3 }),
      producer({ producerRevisions: ["rev-1"] }),
      producer({ allowAny: true }),
      "", "{}", "{",
    ]) expect(parseTelemetryProducerTenantsV2(bad)).toBeNull();
  });

  it("never lets a v2 grant stand in for v1 enrolment, or the reverse", () => {
    // A v2 producer grant is not a valid v1 grant (unknown field), so it cannot enable T1 by accident.
    expect(parseTelemetryTenants(producer())).toBeNull();
    const v1 = JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY } });
    expect(parseTelemetryTenants(v1)).not.toBeNull();
    expect(parseTelemetryProducerTenantsV2(v1)).toBeNull();
    expect(parseTelemetryReceiverTenantsV2(v1)).toBeNull();
  });

  it("requires an explicit, bounded list of approved revisions on the receiver", () => {
    const receiver = (revisions: unknown) => JSON.stringify({
      tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevisions: revisions },
    });
    expect(parseTelemetryReceiverTenantsV2(receiver(["rev-1", "rev-2"]))?.get("tenant_educateos")?.producerRevisions).toEqual(["rev-1", "rev-2"]);
    for (const bad of [[], ["rev-1", "rev-1"], ["bad rev"], "rev-1", undefined, Array.from({ length: 17 }, (_, i) => `r${i}`)]) {
      expect(parseTelemetryReceiverTenantsV2(receiver(bad))).toBeNull();
    }
    expect(parseTelemetryReceiverTenantsV2(producer())).toBeNull();
  });
});
