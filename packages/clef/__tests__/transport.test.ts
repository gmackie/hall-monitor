import { describe, expect, it } from "vitest";
import { ClefTransportError, gatewayFetchTransport, type WorkersAiBinding, workersAiBindingTransport } from "../src/index.ts";

const signal = new AbortController().signal;

describe("workersAiBindingTransport", () => {
  it("routes through the gateway with payload logging off", async () => {
    const calls: unknown[] = [];
    const ai: WorkersAiBinding = {
      aiGatewayLogId: "log_123",
      async run(model, inputs, options) {
        calls.push({ model, inputs, options });
        return { answers: {}, usage: { input_tokens: 40, output_tokens: 0 } };
      },
    };
    const result = await workersAiBindingTransport(ai, { id: "hall-monitor", metadata: { tenant: "t_1" } }).run("@cf/x", { input: "hi" }, { signal });
    expect(result).toEqual({ output: { answers: {}, usage: { input_tokens: 40, output_tokens: 0 } }, usage: { inputTokens: 40 }, gatewayLogId: "log_123" });
    expect(calls).toEqual([
      {
        model: "@cf/x",
        inputs: { input: "hi" },
        options: { signal, gateway: { id: "hall-monitor", metadata: { tenant: "t_1" } }, extraHeaders: { "cf-aig-collect-log-payload": "false" } },
      },
    ]);
  });

  it("classifies binding errors", async () => {
    const failing = (error: unknown): WorkersAiBinding => ({
      async run() {
        throw error;
      },
    });
    await expect(workersAiBindingTransport(failing(new Error("3040: 429 Too Many Requests"))).run("m", {}, { signal })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    await expect(workersAiBindingTransport(failing(Object.assign(new Error("x"), { status: 503 }))).run("m", {}, { signal })).rejects.toMatchObject({
      kind: "unavailable",
      status: 503,
    });
  });
});

describe("gatewayFetchTransport", () => {
  function transport(response: Response | Error, seen: { url?: string; init?: RequestInit } = {}) {
    return gatewayFetchTransport({
      accountId: "acct",
      gatewayId: "gw",
      token: "test-token",
      metadata: { product: "educateos" },
      fetch: async (url, init) => {
        seen.url = String(url);
        if (init !== undefined) seen.init = init;
        if (response instanceof Error) throw response;
        return response;
      },
    });
  }

  it("posts to the Workers AI gateway endpoint and unwraps the result", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const response = new Response(JSON.stringify({ success: true, result: { answers: {}, usage: { input_tokens: 9, output_tokens: 0 } } }), {
      headers: { "cf-aig-log-id": "log_9", "cf-ray": "8f00aa-SJC" },
    });
    const result = await transport(response, seen).run("@cf/cloudflare/clef-flash", { input: "x" }, { signal });
    expect(seen.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai/@cf/cloudflare/clef-flash");
    expect(seen.init?.headers).toMatchObject({ "cf-aig-collect-log-payload": "false", "cf-aig-metadata": '{"product":"educateos"}' });
    expect(result).toEqual({ output: { answers: {}, usage: { input_tokens: 9, output_tokens: 0 } }, usage: { inputTokens: 9 }, providerRequestId: "8f00aa-SJC", gatewayLogId: "log_9" });
  });

  it.each([
    [429, "rate_limited"],
    [502, "unavailable"],
    [400, "rejected"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    await expect(transport(new Response("{}", { status })).run("m", {}, { signal })).rejects.toMatchObject({ kind, status });
  });

  it("maps network errors to unavailable without leaking details", async () => {
    const error = await transport(new TypeError("connect ECONNREFUSED")).run("m", {}, { signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClefTransportError);
    expect((error as Error).message).toBe("Clef request failed: unavailable");
  });
});
