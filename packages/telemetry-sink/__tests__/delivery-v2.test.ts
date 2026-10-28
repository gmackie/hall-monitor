import { describe, expect, it } from "vitest";
import {
  buildTelemetryDeliveryV2, newDeliveryId, type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";
import {
  sendDeliveryV2, signTelemetryAckV2, signedDeliveryRequestV2, signedTelemetryRequest,
  verifyDeliveryRequestV2, verifyTelemetryRequest, type TelemetryBinding,
} from "../src/index.ts";

const KEY = "synthetic-v2-sink-signing-key-0123456789-abcdefg";
const OTHER_KEY = "synthetic-other-tenant-key-0123456789-abcdefgh";
const TENANT = "tenant_educateos";
const event: TemporalMetricEvent = {
  schemaVersion: 1, occurredAt: "2026-10-28T18:00:00.000Z",
  kind: "content_evaluated", category: "none", priority: "routine",
  modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown",
};

async function built() {
  return buildTelemetryDeliveryV2({ deliveryId: newDeliveryId(), producerRevision: "rev-1", events: [event] });
}

describe("v2 request signing", () => {
  it("round-trips, binding tenant, timestamp and the exact bytes, and reports the digest", async () => {
    const { payload, digest, delivery } = await built();
    const request = await signedDeliveryRequestV2(TENANT, KEY, payload, digest);
    expect(new URL(request.url).pathname).toBe("/internal/v2/telemetry");
    const verified = await verifyDeliveryRequestV2(request, KEY);
    expect(verified).toMatchObject({ tenant: TENANT, digest });
    expect(verified.delivery).toEqual(delivery);
  });

  it("is domain-separated: a v1 signature is not a v2 one and the reverse", async () => {
    const { payload, digest } = await built();
    const v2 = await signedDeliveryRequestV2(TENANT, KEY, payload, digest);
    // The same headers and bytes, aimed at the other protocol's path, must fail.
    const asV1 = new Request("https://telemetry.internal/internal/v1/telemetry", { method: "POST", headers: v2.headers, body: payload });
    await expect(verifyTelemetryRequest(asV1, KEY)).rejects.toThrow();
    const v1 = await signedTelemetryRequest(TENANT, KEY, { schemaVersion: 1, events: [event] });
    const body = await v1.clone().text();
    const asV2 = new Request("https://telemetry.internal/internal/v2/telemetry", { method: "POST", headers: v1.headers, body });
    await expect(verifyDeliveryRequestV2(asV2, KEY)).rejects.toThrow();
  });

  it("rejects wrong key, tenant swap, tampered body, stale time, and a digest that is not the payload's", async () => {
    const { payload, digest } = await built();
    const request = await signedDeliveryRequestV2(TENANT, KEY, payload, digest);
    await expect(verifyDeliveryRequestV2(request.clone(), OTHER_KEY)).rejects.toThrow();
    const swapped = new Request(request.url, { method: "POST", headers: new Headers(request.headers), body: payload });
    swapped.headers.set("x-hm-telemetry-tenant", "tenant_other");
    await expect(verifyDeliveryRequestV2(swapped, KEY)).rejects.toThrow();
    const tampered = new Request(request.url, { method: "POST", headers: request.headers, body: payload.replace("rev-1", "rev-2") });
    await expect(verifyDeliveryRequestV2(tampered, KEY)).rejects.toThrow();
    const old = await signedDeliveryRequestV2(TENANT, KEY, payload, digest, Math.floor(Date.now() / 1000) - 301);
    await expect(verifyDeliveryRequestV2(old, KEY)).rejects.toThrow();
    await expect(signedDeliveryRequestV2(TENANT, KEY, payload, "0".repeat(64))).rejects.toThrow();
    await expect(signedDeliveryRequestV2("bad tenant", KEY, payload, digest)).rejects.toThrow();
  });

  it("bounds the body while streaming, even with no Content-Length", async () => {
    const { payload, digest } = await built();
    const request = await signedDeliveryRequestV2(TENANT, KEY, payload, digest);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const huge = new Request(request.url, { method: "POST", headers, body: "X".repeat(16 * 1024 + 1) });
    await expect(verifyDeliveryRequestV2(huge, KEY)).rejects.toThrow();
  });

  it("a retry re-sends identical bytes and digest under a fresh timestamp and signature", async () => {
    const { payload, digest } = await built();
    const t = Math.floor(Date.now() / 1000);
    const first = await signedDeliveryRequestV2(TENANT, KEY, payload, digest, t);
    const retry = await signedDeliveryRequestV2(TENANT, KEY, payload, digest, t + 60);
    expect(await first.text()).toBe(await retry.text());
    expect(retry.headers.get("x-hm-telemetry-time")).not.toBe(first.headers.get("x-hm-telemetry-time"));
    expect(retry.headers.get("x-hm-telemetry-signature")).not.toBe(first.headers.get("x-hm-telemetry-signature"));
  });
});

describe("sendDeliveryV2 outcomes", () => {
  const respond = (make: (id: string, digest: string) => Promise<Response> | Response): TelemetryBinding => ({
    async fetch(request: Request) {
      const { delivery, digest } = await verifyDeliveryRequestV2(request, KEY);
      return make(delivery.deliveryId, digest);
    },
  });
  const ackBody = (status: "committed" | "deduplicated", id: string, digest: string, key = KEY) =>
    signTelemetryAckV2(TENANT, key, status, id, digest);

  it("clears only on a verified durable ack for this ID and digest, committed or deduplicated", async () => {
    const { payload, digest } = await built();
    for (const status of ["committed", "deduplicated"] as const) {
      const binding = respond(async (id, d) => Response.json(await ackBody(status, id, d)));
      expect(await sendDeliveryV2(binding, TENANT, KEY, payload, digest)).toEqual({ kind: "acked", status });
    }
  });

  it("never treats T1's 202 persisted:false or any non-200 as durable", async () => {
    const { payload, digest } = await built();
    const t1 = respond(() => Response.json({ code: "validated_not_persisted", accepted: 1, persisted: false }, { status: 202 }));
    expect(await sendDeliveryV2(t1, TENANT, KEY, payload, digest)).toEqual({ kind: "retry", reason: "not_durable" });
    for (const [status, reason] of [[201, "rejected"], [204, "rejected"], [401, "rejected"], [403, "rejected"], [429, "unavailable"], [503, "unavailable"]] as const) {
      const binding = respond(() => new Response(null, { status }));
      expect(await sendDeliveryV2(binding, TENANT, KEY, payload, digest)).toEqual({ kind: "retry", reason });
    }
  });

  it("rejects invalid, mismatched, wrong-tenant and forged acks", async () => {
    const { payload, digest } = await built();
    const other = newDeliveryId();
    const cases: [string, (id: string, d: string) => Promise<Response> | Response, string][] = [
      ["empty body", () => new Response(null, { status: 200 }), "invalid_ack"],
      ["not json", () => new Response("ok", { status: 200 }), "invalid_ack"],
      ["v1 body at 200", () => Response.json({ code: "validated_not_persisted", accepted: 1, persisted: false }), "invalid_ack"],
      ["oversize", () => new Response("x".repeat(5000), { status: 200 }), "invalid_ack"],
      ["other delivery id", async (_id, d) => Response.json(await ackBody("committed", other, d)), "mismatched_ack"],
      ["other digest", async (id) => Response.json(await ackBody("committed", id, "0".repeat(64))), "mismatched_ack"],
      ["other tenant's key", async (id, d) => Response.json(await ackBody("committed", id, d, OTHER_KEY)), "mismatched_ack"],
      ["status swapped after signing", async (id, d) => Response.json({ ...await ackBody("committed", id, d), status: "deduplicated" }), "mismatched_ack"],
    ];
    for (const [name, make, reason] of cases) {
      expect(await sendDeliveryV2(respond(make), TENANT, KEY, payload, digest), name).toEqual({ kind: "retry", reason });
    }
  });

  it("reports a digest conflict distinctly so the caller stops retrying", async () => {
    const { payload, digest } = await built();
    const binding = respond(() => new Response(JSON.stringify({ code: "digest_conflict" }), { status: 409 }));
    expect(await sendDeliveryV2(binding, TENANT, KEY, payload, digest)).toEqual({ kind: "conflict" });
  });

  it("turns a hang into a timeout and a thrown error into 'unavailable', without leaking the message", async () => {
    const { payload, digest } = await built();
    const hang: TelemetryBinding = { fetch: () => new Promise<Response>(() => {}) };
    expect(await sendDeliveryV2(hang, TENANT, KEY, payload, digest, { timeoutMs: 30 })).toEqual({ kind: "retry", reason: "timeout" });
    const boom: TelemetryBinding = { fetch: async () => { throw new Error("SECRET-SENTINEL"); } };
    const outcome = await sendDeliveryV2(boom, TENANT, KEY, payload, digest);
    expect(outcome).toEqual({ kind: "retry", reason: "unavailable" });
    expect(JSON.stringify(outcome)).not.toContain("SECRET-SENTINEL");
  });
});
