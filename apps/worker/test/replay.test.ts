import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { createHallMonitorClient, serviceBindingTransport, serviceTokenSource } from "@gmacko/hall-monitor-client";
import { ErrorBody, EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOKEN_LIFETIME_SECONDS } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import type { TokenReplayGuard } from "../src/replay.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, direct, evaluationRequest } from "./helpers.ts";
import { mintToken, signingKey } from "./tokens.ts";

const BASE = "https://hall-monitor.test";
const post = (token: string, body: unknown) => SELF.fetch(`${BASE}/v1/evaluations`, call("POST", token, body));

let logLines: string[] = [];
beforeEach(() => {
  fakeAi.reset();
  logLines = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401);
  const body = ErrorBody.parse(await response.json());
  expect(body).toMatchObject({ code: "unauthorized", retryable: false });
}

describe("service-token replay (jti)", () => {
  it("accepts a token once and rejects its replay with 401 unauthorized, not retryable", async () => {
    const token = await mintToken("educateos");
    expect((await post(token, evaluationRequest())).status).toBe(200);
    await expectUnauthorized(await post(token, evaluationRequest()));
    // The replay was refused before evaluation: one classifier call, for the first request only.
    expect(fakeAi.calls).toHaveLength(1);
    expect(logLines.some((line) => line.includes('"event":"auth.rejected"') && line.includes('"authFailure":"replayed"'))).toBe(true);
    // Read-only routes consume tokens too.
    const read = await mintToken("educateos");
    expect((await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", read))).status).toBe(200);
    await expectUnauthorized(await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", read)));
  });

  it("accepts distinct jti values, including for an idempotent replay of the same request", async () => {
    const request = evaluationRequest();
    const first = await post(await mintToken("educateos"), request);
    const second = await post(await mintToken("educateos"), request);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
  });

  it("scopes a jti to its issuer", async () => {
    const jti = crypto.randomUUID();
    const educateos = await mintToken("educateos", { claims: { jti } });
    const playtrek = await mintToken("playtrek", { tenant: "tenant_educateos", claims: { jti, aud: "hall-monitor" } });
    expect((await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", educateos))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", playtrek))).status).toBe(200);
  });

  it("accepts exactly one of two simultaneous uses of a token", async () => {
    const token = await mintToken("educateos");
    const responses = await Promise.all([post(token, evaluationRequest()), post(token, evaluationRequest())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it("refuses tokens whose lifetime exceeds the bound the replay record relies on", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectUnauthorized(await post(await mintToken("educateos", { claims: { exp: now + MAX_TOKEN_LIFETIME_SECONDS + 3600 } }), evaluationRequest()));
    expect((await post(await mintToken("educateos", { claims: { exp: now + MAX_TOKEN_LIFETIME_SECONDS } }), evaluationRequest())).status).toBe(200);
  });

  it("fails closed with 503 when the replay guard is not bound", async () => {
    const response = await direct("/v1/evaluations", call("POST", await mintToken("educateos"), evaluationRequest()), { TOKEN_REPLAY_GUARD: undefined } as unknown as Partial<Env>);
    expect(response.status).toBe(503);
    expect(ErrorBody.parse(await response.json()).code).toBe("unavailable");
  });

  it("re-mints a token for each client retry, so an idempotent retry is not a replay", async () => {
    const key = signingKey("educateos");
    const jtis: string[] = [];
    const getToken = serviceTokenSource({
      issuer: key.iss,
      audience: "hall-monitor",
      tenant: "tenant_educateos",
      scope: ["evaluate"],
      algorithm: key.alg,
      keyId: key.jwk.kid,
      privateKey: await key.privateKey(),
      newTokenId: () => {
        const jti = crypto.randomUUID();
        jtis.push(jti);
        return jti;
      },
    });
    let attempts = 0;
    // The first attempt reaches the Worker but its response is lost, the worst case for a retry.
    const flaky = {
      async fetch(request: Request) {
        const response = await SELF.fetch(request);
        return ++attempts === 1 ? new Response(null, { status: 503 }) : response;
      },
    };
    const client = createHallMonitorClient({ transport: serviceBindingTransport(flaky, { getToken }), random: () => 0, sleep: async () => {} });
    const result = await client.evaluate(evaluationRequest());
    expect(EvaluationResult.parse(result).decision).toBe("allow");
    expect(attempts).toBe(2);
    expect(new Set(jtis).size).toBe(2);
    // The retry replayed the stored result rather than evaluating twice.
    expect(fakeAi.calls).toHaveLength(1);
  });
});

describe("TokenReplayGuard", () => {
  it("records a pair until its expiry and purges it on the alarm", async () => {
    const stub = env.TOKEN_REPLAY_GUARD!.get(env.TOKEN_REPLAY_GUARD!.idFromName("guard-test-1"));
    const expiresAt = Date.now() + 60_000;
    expect(await stub.claim("iss-a", "jti-1", expiresAt)).toBe(true);
    expect(await stub.claim("iss-a", "jti-1", expiresAt)).toBe(false);
    expect(await stub.claim("iss-b", "jti-1", expiresAt)).toBe(true);
    await runInDurableObject(stub, async (_instance: TokenReplayGuard, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
      state.storage.sql.exec("UPDATE seen_tokens SET expires_at = ? WHERE issuer = 'iss-a'", Date.now() - 1);
    });
    // An expired row no longer blocks (its token would fail `exp` verification anyway).
    expect(await stub.claim("iss-a", "jti-1", expiresAt)).toBe(true);
    await runInDurableObject(stub, (_instance: TokenReplayGuard, state) => {
      state.storage.sql.exec("UPDATE seen_tokens SET expires_at = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance: TokenReplayGuard, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM seen_tokens").one().n).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("schedules the alarm for the earliest expiry and keeps later rows", async () => {
    const stub = env.TOKEN_REPLAY_GUARD!.get(env.TOKEN_REPLAY_GUARD!.idFromName("guard-test-2"));
    const soon = Date.now() + 30_000;
    const later = Date.now() + 90_000;
    await stub.claim("iss", "late", later);
    await stub.claim("iss", "early", soon);
    await runInDurableObject(stub, async (_instance: TokenReplayGuard, state) => {
      expect(await state.storage.getAlarm()).toBe(soon);
      state.storage.sql.exec("UPDATE seen_tokens SET expires_at = ? WHERE jti = 'early'", Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance: TokenReplayGuard, state) => {
      expect(state.storage.sql.exec("SELECT jti FROM seen_tokens").toArray()).toEqual([{ jti: "late" }]);
      expect(await state.storage.getAlarm()).toBe(later);
    });
    expect(await stub.claim("iss", "late", later)).toBe(false);
  });

  it("lets exactly one of many concurrent claims of a pair succeed", async () => {
    const stub = env.TOKEN_REPLAY_GUARD!.get(env.TOKEN_REPLAY_GUARD!.idFromName("guard-test-3"));
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => stub.claim("iss", "same", Date.now() + 60_000)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});
