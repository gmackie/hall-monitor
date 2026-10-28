import { describe, expect, it } from "vitest";
import {
  signedTelemetryRequest, verifyTelemetryRequest, sendTelemetry,
} from "../src/index.ts";
import type { TemporalMetricEvent } from "@gmacko/hall-monitor-telemetry-contracts";

const KEY = "synthetic-testing-signature-key-0123456789abcdefgh";
const OTHER_KEY = "synthetic-other-tenant-signature-key-01234567890";
const TENANT = "tenant_educateos";
const e: TemporalMetricEvent = {
  schemaVersion: 1, occurredAt: "2026-10-28T18:00:00Z",
  kind: "content_evaluated", category: "none", priority: "routine",
  modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown",
};
const batch = { schemaVersion: 1 as const, events: [e] };

describe("tenant-signed private telemetry requests", () => {
  it("round trips through HMAC verification and a fake service binding", async () => {
    let observed = 0;
    const binding = {
      async fetch(req: Request) {
        const verified = await verifyTelemetryRequest(req, KEY);
        expect(verified.tenant).toBe(TENANT);
        expect(verified.batch).toEqual(batch);
        observed++;
        return new Response(null, { status: 202 });
      },
    };
    expect(await sendTelemetry(binding, TENANT, KEY, batch)).toBe(true);
    expect(observed).toBe(1);
  });

  it("fails on changed tenant, tampered body, wrong key and stale timestamp", async () => {
    const base = await signedTelemetryRequest(TENANT, KEY, batch);
    await expect(signedTelemetryRequest("other tenant", KEY, batch)).rejects.toThrow();
    await expect(verifyTelemetryRequest(base.clone(), OTHER_KEY)).rejects.toThrow();
    const changed = new Request(base.clone(), { headers: new Headers(base.headers) });
    changed.headers.set("x-hm-telemetry-tenant", "tenant_other");
    await expect(verifyTelemetryRequest(changed, KEY)).rejects.toThrow();
    const tampered = new Request(base.url, {
      method: "POST", headers: base.headers,
      body: JSON.stringify({ schemaVersion: 1, events: [{ ...e, category: "harassment" }] }),
    });
    await expect(verifyTelemetryRequest(tampered, KEY)).rejects.toThrow();
    const old = await signedTelemetryRequest(TENANT, KEY, batch, Math.floor(Date.now() / 1000) - 301);
    await expect(verifyTelemetryRequest(old, KEY)).rejects.toThrow();
  });

  it("rejects PII or unauthorized schema BEFORE sending to any binding", async () => {
    let called = false;
    const binding = { async fetch(_req: Request) { called = true; return new Response(null, { status: 202 }); } };
    await expect(sendTelemetry(binding, TENANT, KEY, { schemaVersion: 1, events: [{ ...e, text: "SENTINEL" }] } as never)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("rejects oversized request bodies even without a trustworthy Content-Length", async () => {
    const signed = await signedTelemetryRequest(TENANT, KEY, batch);
    const headers = new Headers(signed.headers);
    headers.delete("content-length");
    const oversized = new Request(signed.url, {
      method: "POST",
      headers,
      body: "X".repeat(16 * 1024 + 1),
    });
    await expect(verifyTelemetryRequest(oversized, KEY)).rejects.toThrow();
  });

  it("recognizes non-202 as no accepted telemetry and never retries", async () => {
    let called = 0;
    const binding = { async fetch(_req: Request) { called++; return new Response(null, { status: 503 }); } };
    expect(await sendTelemetry(binding, TENANT, KEY, batch)).toBe(false);
    expect(called).toBe(1);
  });
});
