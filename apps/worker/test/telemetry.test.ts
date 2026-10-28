import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app.ts";
import type { Env } from "../src/env.ts";
import { verifyTelemetryRequest } from "@gmacko/hall-monitor-telemetry-sink";
import { fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const SECRET = "synthetic-opt-in-telemetry-key-1234567890-abcdef";
const allow = JSON.stringify({
  tenant_educateos: { source: "educateos", gradeBands: ["g9_12"], signingKey: SECRET },
});

function captureContext() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) { promises.push(p); },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    drain: () => Promise.all(promises),
  };
}

function fixture(extra: Partial<Env> = {}) {
  const requests: Request[] = [];
  const collector = {
    async fetch(request: Request) {
      requests.push(request.clone());
      return new Response(JSON.stringify({ code: "validated_not_persisted", accepted: 1, persisted: false }), { status: 202 });
    },
  };
  return {
    requests,
    collector,
    bindings: {
      ...env, AI: fakeAi,
      HM_TELEMETRY_ENABLED: "true",
      HM_TELEMETRY_TENANTS: allow,
      METRICS_COLLECTOR: collector,
      ...extra,
    } as Env,
  };
}

async function evaluated(bindings: Env, ctx: ExecutionContext, request = evaluationRequest()) {
  return handle(
    new Request("https://hall-monitor.test/v1/evaluations", call("POST", await mintToken("educateos"), request)),
    bindings, ctx,
  );
}

describe("T1 opt-in, content-free metrics after evaluation", () => {
  beforeEach(() => {
    fakeAi.reset();
    vi.restoreAllMocks();
  });

  it("is disabled by default, even with a reachable collector", async () => {
    const f = fixture();
    const disabled = { ...f.bindings };
    delete disabled.HM_TELEMETRY_ENABLED;
    const context = captureContext();
    expect((await evaluated(disabled, context.ctx)).status).toBe(200);
    await context.drain();
    expect(f.requests).toHaveLength(0);
  });

  it("emits only fixed metrics after a newly committed successful evaluation", async () => {
    const f = fixture();
    const context = captureContext();
    const input = evaluationRequest({ text: SENTINEL + " ordinary question" });
    const response = await evaluated(f.bindings, context.ctx, input);
    expect(response.status).toBe(200);
    await context.drain();
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    const body = await request.clone().text();
    expect(body).not.toContain(SENTINEL);
    expect(body).not.toContain(input.requestId);
    expect(body).not.toContain(input.idempotencyKey);
    expect(body).not.toContain(input.source.tenantId);
    expect(body).not.toContain(input.context.costCenterId);
    const verified = await verifyTelemetryRequest(request, SECRET);
    expect(verified.tenant).toBe("tenant_educateos");
    expect(verified.batch.events).toHaveLength(1);
    expect(verified.batch.events[0]).toMatchObject({
      schemaVersion: 1, kind: "content_evaluated", category: "none", gradeBand: "g9_12",
      source: "educateos", calendarKind: "unknown", priority: "routine",
    });
  });

  it("emits no duplicate on idempotent replay", async () => {
    const f = fixture();
    const request = evaluationRequest();
    const first = captureContext();
    expect((await evaluated(f.bindings, first.ctx, request)).status).toBe(200);
    await first.drain();
    const second = captureContext();
    const response = await evaluated(f.bindings, second.ctx, request);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
    await second.drain();
    expect(f.requests).toHaveLength(1);
  });

  it("includes a candidate flag for a real safety finding, not a classifier outage", async () => {
    const f = fixture();
    const context = captureContext();
    const response = await evaluated(f.bindings, context.ctx,
      evaluationRequest({ text: SENTINEL + " " + HARASSMENT_MARKER }));
    expect(response.status).toBe(200);
    await context.drain();
    const verified = await verifyTelemetryRequest(f.requests[0]!, SECRET);
    expect(verified.batch.events.map((e) => e.kind)).toEqual(["content_evaluated", "candidate_flagged"]);
    expect(verified.batch.events[1]).toMatchObject({ category: "other", priority: "routine" });
    // A model failure can hold content without contributing to inferred bullying counts.
    const failing = fixture();
    fakeAi.failing = true;
    const ctx2 = captureContext();
    expect((await evaluated(failing.bindings, ctx2.ctx)).status).toBe(200);
    await ctx2.drain();
    const failBatch = await verifyTelemetryRequest(failing.requests[0]!, SECRET);
    expect(failBatch.batch.events.map((e) => e.kind)).toEqual(["content_evaluated"]);
  });

  it("fails closed for unapproved tenant/source/grade or malformed grants", async () => {
    for (const config of [
      "{}",
      "{invalid",
      JSON.stringify({ tenant_other: { source: "educateos", gradeBands: ["g9_12"], signingKey: SECRET } }),
      JSON.stringify({ tenant_educateos: { source: "playtrek", gradeBands: ["g9_12"], signingKey: SECRET } }),
      JSON.stringify({ tenant_educateos: { source: "educateos", gradeBands: ["g6_8"], signingKey: SECRET } }),
    ]) {
      const f = fixture({ HM_TELEMETRY_TENANTS: config });
      const ctx = captureContext();
      expect((await evaluated(f.bindings, ctx.ctx)).status).toBe(200);
      await ctx.drain();
      expect(f.requests).toHaveLength(0);
    }
  });

  it("does not emit on failed or unauthorized evaluations", async () => {
    const f = fixture();
    const ctx = captureContext();
    const malformed = evaluationRequest();
    const unauthorized = await handle(new Request("https://hall-monitor.test/v1/evaluations", call("POST", undefined, malformed)), f.bindings, ctx.ctx);
    expect(unauthorized.status).toBe(401);
    const invalid = {
      ...malformed,
      idempotencyKey: "idem_invalid_telemetry",
      policy: { profileId: "missing", revision: "builtin-1" },
    };
    const failed = await evaluated(f.bindings, ctx.ctx, invalid);
    expect(failed.status).toBe(404);
    await ctx.drain();
    expect(f.requests).toHaveLength(0);
  });

  it("does not change the moderation result when the collector rejects or throws", async () => {
    for (const brokenCollector of [
      { fetch: async (_req: Request) => new Response(null, { status: 503 }) },
      { fetch: async (_req: Request): Promise<Response> => { throw new Error(SENTINEL); } },
    ]) {
      const f = fixture({ METRICS_COLLECTOR: brokenCollector });
      const ctx = captureContext();
      const logs: string[] = [];
      const original = console.warn;
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
      const response = await evaluated(f.bindings, ctx.ctx);
      expect(response.status).toBe(200);
      await ctx.drain();
      expect(logs.join(" ")).toContain("telemetry.delivery_failed");
      expect(logs.join(" ")).not.toContain(SENTINEL);
      console.warn = original;
      vi.restoreAllMocks();
    }
  });
});
