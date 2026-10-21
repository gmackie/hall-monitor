import type { EvaluationRequest, EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { describe, expect, it } from "vitest";
import {
  createHallMonitorClient,
  fetchTransport,
  HallMonitorError,
  type HallMonitorClientOptions,
  HallMonitorTimeoutError,
  SERVICE_BINDING_ORIGIN,
  serviceBindingTransport,
  serviceTokenSource,
  type SigningKey,
} from "../src/index.ts";

/** Synthetic request; the text is invented and must never appear in errors. */
const REQUEST: EvaluationRequest = {
  schemaVersion: "1.0",
  requestId: "req_client_1",
  idempotencyKey: "idem_client_1",
  source: { product: "other", tenantId: "tenant_a", surface: "test.surface" },
  policy: { profileId: "educator", revision: "builtin-1" },
  context: { audience: "educator", costCenterId: "cc_test" },
  evaluationKind: "content.candidate",
  content: { type: "text", text: "SECRET-SYNTHETIC-CONTENT about volcanoes" },
};

const RESULT: EvaluationResult = {
  schemaVersion: "1.0",
  evaluationId: "eval_client_1",
  requestId: "req_client_1",
  decision: "allow",
  reasonCodes: [],
  findings: [],
  uncertain: false,
  policyRevision: "builtin-1",
  evaluatorBundleRevision: "base-1.0.0",
  resolverVersion: "resolver-1.0.0",
  receipt: null,
};

type Reply = Response | Error | ((init: RequestInit) => Promise<Response>);

/** A scripted fetch that records every call. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("unexpected call");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(init);
    return reply;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(replies: Reply[], options: Partial<HallMonitorClientOptions> = {}) {
  const fake = fakeFetch(replies);
  const sleeps: number[] = [];
  const instance = createHallMonitorClient({
    transport: fetchTransport({ baseUrl: "https://hm.example.test/", getToken: async () => "token-1", fetch: fake.fetch }),
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client: instance, calls: fake.calls, sleeps };
}

describe("createHallMonitorClient", () => {
  it("posts an evaluation with a bearer token and validates the result", async () => {
    const { client: hm, calls } = client([json(RESULT)]);
    await expect(hm.evaluate(REQUEST)).resolves.toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hm.example.test/v1/evaluations");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(REQUEST);
  });

  it("raises typed errors from the service's error body", async () => {
    const { client: hm } = client([json({ code: "forbidden", message: "tenant does not match the token", retryable: false }, 403)]);
    const error = await hm.evaluate(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HallMonitorError);
    expect(error).toMatchObject({ code: "forbidden", status: 403, retryable: false });
  });

  it("retries a 503 once with jittered backoff and then succeeds", async () => {
    const { client: hm, calls, sleeps } = client([json({ code: "unavailable", message: "down", retryable: true }, 503), json(RESULT)]);
    await expect(hm.evaluate(REQUEST)).resolves.toEqual(RESULT);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([50]);
  });

  it("honors Retry-After on 429, capped by the backoff maximum", async () => {
    const { client: hm, sleeps } = client([
      json({ code: "rate_limited", message: "slow down", retryable: true }, 429, { "retry-after": "1" }),
      json(RESULT),
    ]);
    await hm.evaluate(REQUEST);
    expect(sleeps).toEqual([1000]);
  });

  it("retries network errors, but no more than `retries` times", async () => {
    const { client: hm, calls } = client([new TypeError("connection reset"), new TypeError("connection reset")]);
    const error = await hm.evaluate(REQUEST).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("does not retry 4xx errors, including idempotency conflicts", async () => {
    for (const [status, code] of [
      [400, "invalid_request"],
      [401, "unauthorized"],
      [409, "idempotency_conflict"],
    ] as const) {
      const { client: hm, calls } = client([json({ code, message: "no", retryable: false }, status), json(RESULT)], { retries: 3 });
      await expect(hm.evaluate(REQUEST)).rejects.toMatchObject({ code, status });
      expect(calls).toHaveLength(1);
    }
  });

  it("synthesizes an error when the service sends no error body", async () => {
    const { client: hm } = client([new Response("<html>bad gateway</html>", { status: 502 }), new Response("", { status: 502 })]);
    await expect(hm.evaluate(REQUEST)).rejects.toMatchObject({ code: "unavailable", status: 502, retryable: true });
  });

  it("rejects responses that do not match the wire schema", async () => {
    const { client: hm } = client([json({ ...RESULT, decision: "maybe" })]);
    await expect(hm.evaluate(REQUEST)).rejects.toMatchObject({ code: "unavailable", retryable: false });
  });

  it("validates requests before sending, naming fields but never content", async () => {
    const { client: hm, calls } = client([]);
    const bad = { ...REQUEST, source: { ...REQUEST.source, tenantId: "not a valid id" } };
    const error = (await hm.evaluate(bad).catch((caught: unknown) => caught)) as HallMonitorError;
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("source.tenantId");
    expect(error.message).not.toContain("SECRET-SYNTHETIC-CONTENT");
    expect(calls).toHaveLength(0);
  });

  it("times out with a typed error and aborts the in-flight request", async () => {
    let aborted = false;
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      );
    const { client: hm } = client([hang], { timeoutMs: 20 });
    const error = await hm.evaluate(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HallMonitorTimeoutError);
    expect(error).toMatchObject({ code: "unavailable", retryable: true, timeoutMs: 20 });
    expect(aborted).toBe(true);
  });

  it("rethrows the caller's abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    const { client: hm } = client([json(RESULT)]);
    await expect(hm.evaluate(REQUEST, { signal: controller.signal })).rejects.toThrow("caller gave up");
  });

  it("returns null for a missing receipt and encodes the id", async () => {
    const { client: hm, calls } = client([json({ code: "invalid_request", message: "receipt not found", retryable: false }, 404)]);
    await expect(hm.receipt("eval_missing")).resolves.toBeNull();
    expect(calls[0]!.url).toBe("https://hm.example.test/v1/receipts/eval_missing");
    await expect(hm.receipt("../etc")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses batches with interactive kinds before sending", async () => {
    const { client: hm, calls } = client([]);
    await expect(hm.evaluateBatch([{ ...REQUEST, evaluationKind: "interaction.input" }])).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("parses batch and capability responses", async () => {
    const capabilities = {
      schemaVersion: "1.0",
      supportedSchemaVersions: ["1.0"],
      evaluationKinds: ["content.candidate"],
      evaluatorBundles: [{ id: "hall-monitor-base", revision: "base-1.0.0" }],
      policyProfiles: [{ id: "educator", revision: "builtin-1" }],
      resolverVersion: "resolver-1.0.0",
      classifier: { enabled: false, models: [] },
    };
    const batch = {
      schemaVersion: "1.0",
      items: [
        { status: "ok", result: RESULT },
        { status: "error", requestId: "req_2", error: { code: "policy_not_found", message: "no", retryable: false } },
      ],
    };
    const { client: hm, calls } = client([json(batch), json(capabilities)]);
    await expect(hm.evaluateBatch([REQUEST, { ...REQUEST, requestId: "req_2", idempotencyKey: "idem_2" }])).resolves.toEqual(batch);
    await expect(hm.capabilities()).resolves.toEqual(capabilities);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "https://hm.example.test/v1/evaluations:batch"],
      ["GET", "https://hm.example.test/v1/capabilities"],
    ]);
  });
});

describe("transports", () => {
  it("refuses a plaintext base URL except on loopback", () => {
    expect(() => fetchTransport({ baseUrl: "http://hm.example.test", getToken: async () => "t" })).toThrow(/https/);
    expect(() => fetchTransport({ baseUrl: "http://localhost:8787", getToken: async () => "t" })).not.toThrow();
  });

  it("sends the same HTTP API through a service binding", async () => {
    const seen: Request[] = [];
    const binding = {
      async fetch(request: Request) {
        seen.push(request);
        return json(RESULT);
      },
    };
    const hm = createHallMonitorClient({ transport: serviceBindingTransport(binding, { getToken: async () => "binding-token" }) });
    await expect(hm.evaluate(REQUEST)).resolves.toEqual(RESULT);
    expect(seen[0]!.url).toBe(`${SERVICE_BINDING_ORIGIN}/v1/evaluations`);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer binding-token");
    expect(await seen[0]!.json()).toEqual(REQUEST);
  });
});

describe("serviceTokenSource", () => {
  const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

  async function source(algorithm: "EdDSA" | "ES256", overrides: { lifetimeSeconds?: number } = {}) {
    const pair =
      algorithm === "EdDSA"
        ? ((await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as unknown as { privateKey: SigningKey; publicKey: SigningKey })
        : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const getToken = serviceTokenSource({
      issuer: "https://issuer.test",
      audience: "hall-monitor",
      tenant: "tenant_a",
      scope: ["evaluate", "receipts:read"],
      algorithm,
      privateKey: pair.privateKey,
      keyId: "key-1",
      now: () => 1_800_000_000,
      ...overrides,
    });
    return { getToken, publicKey: pair.publicKey };
  }

  it.each(["EdDSA", "ES256"] as const)("signs verifiable %s tokens with the service claims", async (algorithm) => {
    const { getToken, publicKey } = await source(algorithm);
    const token = await getToken();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: algorithm, typ: "JWT", kid: "key-1" });
    expect(decode(payload)).toEqual({
      iss: "https://issuer.test",
      aud: "hall-monitor",
      iat: 1_800_000_000,
      exp: 1_800_000_060,
      jti: expect.any(String),
      tenant: "tenant_a",
      scope: "evaluate receipts:read",
    });
    const params = algorithm === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
    const valid = await crypto.subtle.verify(params, publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });

  it("mints a new jti on every call", async () => {
    const { getToken } = await source("EdDSA");
    const tokens = await Promise.all(Array.from({ length: 20 }, () => getToken()));
    const jtis = tokens.map((token) => decode(token.split(".")[1]!).jti);
    expect(new Set(jtis).size).toBe(20);
  });

  it("refuses lifetimes the service would reject", async () => {
    await expect(source("EdDSA", { lifetimeSeconds: 3601 })).rejects.toThrow(RangeError);
    await expect(source("EdDSA", { lifetimeSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it("is asked for a new token on every retry attempt", async () => {
    const { getToken } = await source("EdDSA");
    const sent: string[] = [];
    const fake = fakeFetch([json({ code: "unavailable", message: "down", retryable: true }, 503), json(RESULT)]);
    const hm = createHallMonitorClient({
      transport: fetchTransport({
        baseUrl: "https://hm.example.test",
        getToken: async () => {
          const token = await getToken();
          sent.push(token);
          return token;
        },
        fetch: fake.fetch,
      }),
      random: () => 0,
      sleep: async () => {},
    });
    await expect(hm.evaluate(REQUEST)).resolves.toEqual(RESULT);
    const authorizations = fake.calls.map((call) => (call.init.headers as Record<string, string>).authorization);
    expect(authorizations).toEqual(sent.map((token) => `Bearer ${token}`));
    expect(new Set(sent.map((token) => decode(token.split(".")[1]!).jti)).size).toBe(2);
  });
});
