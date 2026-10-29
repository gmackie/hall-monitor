import { expect, it } from "vitest";
import type { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { parseSyntheticAcceptanceCredentials, runSyntheticEvaluatorAcceptance, validateAcceptanceTarget } from "../src/index.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const TARGET = { url: "https://synthetic.hall-monitor.test", expectedCommit: "a".repeat(40), deploymentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
const READY = { authentication: true, policyOverlays: true, tenantModes: true, idempotencyStore: true, replayGuard: true, classifier: true, decisionPack: true, governanceConfig: true };
const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://synthetic-issuer.test", tenant: "synthetic-tenant", jti: "nonce-1", iat: NOW / 1000, exp: NOW / 1000 + 120, scope: "evaluate receipts:read", ...over });
const token = (over: Record<string, unknown> = {}) => `eyJhbGciOiJFZERTQSJ9.${Buffer.from(JSON.stringify(claims(over))).toString("base64url")}.c3ludGhldGljLXNpZ25hdHVyZQ`;
const credentials = () => ({ mode: "synthetic", tenant: "synthetic-tenant", source: "educateos", tokens: {
  ready: token({ jti: "ready-1" }), evaluate: token({ jti: "evaluate-1" }), replay: token({ jti: "replay-1" }), receipt: token({ jti: "receipt-1" }),
} });

function fixture(over: { mutate?: (phase: number, body: unknown) => unknown; headers?: (phase: number) => Record<string, string>; status?: (phase: number) => number; raw?: (phase: number) => string | undefined; fail?: number } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  let result: EvaluationResult;
  const send: typeof fetch = async (url, init = {}) => {
    const phase = requests.length;
    requests.push({ url: String(url), init });
    if (phase === over.fail) throw new Error("SYNTHETIC-PRIVATE-UPSTREAM-TOKEN-AND-BODY");
    let body: unknown;
    if (phase === 0) body = { status: "ok" };
    else if (phase === 1) body = { ready: true, checks: { ...READY } };
    else if (phase === 2 || phase === 3) {
      const input = JSON.parse(init.body as string) as { requestId: string };
      result ??= { schemaVersion: "1.0", evaluationId: "eval_synthetic_smoke", requestId: input.requestId, decision: "allow", reasonCodes: [], findings: [], uncertain: false,
        policyRevision: "builtin-1", evaluatorBundleRevision: "base-1.0.1:synthetic", resolverVersion: "resolver-1.0.0", receipt: {
          receiptId: "rcpt_synthetic", tenantId: "synthetic-tenant", product: "educateos", logicalRequestId: input.requestId,
          costCenterId: "cc_synthetic_smoke", createdAt: new Date(NOW).toISOString(), purpose: "moderation.input", totalGrossUsdNano: "0", hasUnknownCost: true,
          attempts: [{ attemptId: "att_synthetic", attemptIndex: 0, providerId: "cloudflare-workers-ai", modelId: "synthetic", sku: "synthetic", state: "unknown", units: {},
            grossUsdNano: "0", priceBookId: "synthetic-1" }],
        } };
      body = result;
    } else body = { schemaVersion: "1.0", evaluationId: result!.evaluationId, requestId: result!.requestId, tenantId: "synthetic-tenant", receipt: result!.receipt,
      recordedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString() };
    body = over.mutate?.(phase, body) ?? body;
    return new Response(over.raw?.(phase) ?? JSON.stringify(body), { status: over.status?.(phase) ?? 200,
      headers: { "x-hm-revision": TARGET.expectedCommit, "x-hm-telemetry-posture": "unbound-disabled", ...(phase === 3 ? { "idempotent-replayed": "true" } : {}), ...over.headers?.(phase) } });
  };
  return { requests, send };
}
const run = (f: ReturnType<typeof fixture>, secret = credentials()) => runSyntheticEvaluatorAcceptance({ target: TARGET, credentials: secret, fetch: f.send, now: () => NOW });

it("exercises five real response contracts with distinct tokens, exact replay and a redacted evidence artifact", async () => {
  const f = fixture();
  const r = await run(f);
  expect(r.passed).toBe(true);
  expect(r.checks).toHaveLength(5);
  expect(r.productionEnrollmentApproved).toBe(false);
  expect(r.deploymentMetadata).toBe("operator-supplied-verify-in-forgegraph");
  expect(f.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/health", "/v1/ready", "/v1/evaluations", "/v1/evaluations", "/v1/receipts/eval_synthetic_smoke"]);
  expect(f.requests.every((r) => r.init.redirect === "error" && r.init.signal !== undefined)).toBe(true);
  const auth = f.requests.map((r) => new Headers(r.init.headers).get("authorization"));
  expect(auth[0]).toBeNull(); expect(new Set(auth.slice(1)).size).toBe(4);
  expect(f.requests[2]!.init.body).toBe(f.requests[3]!.init.body);
  const evidence = JSON.stringify(r);
  for (const privateValue of ["synthetic-tenant", "req_smoke", "idem_smoke", "SYNTHETIC-ACCEPTANCE", "eval_synthetic_smoke", ...Object.values(credentials().tokens)]) expect(evidence).not.toContain(privateValue);
});

it.each([0, 1, 2, 3, 4])("rejects a stale serving revision at phase %i and sends no dependent token", async (phase) => {
  const f = fixture({ headers: (p) => p === phase ? { "x-hm-revision": "b".repeat(40) } : {} });
  const r = await run(f);
  expect(r).toMatchObject({ passed: false });
  expect(r.checks.at(-1)).toMatchObject({ failure: "revision" });
  expect(f.requests).toHaveLength(phase + 1);
});

it.each([0, 2, 4])("refuses collection-enabled posture at phase %i", async (phase) => {
  const f = fixture({ headers: (p) => p === phase ? { "x-hm-telemetry-posture": "configured" } : {} });
  const r = await run(f); expect(r.passed).toBe(false); expect(r.checks.at(-1)?.failure).toBe("collection-enabled");
});

it.each([
  (body: unknown) => ({ ...(body as object), checks: { ...READY, classifier: false } }),
  (body: unknown) => ({ ...(body as object), checks: { ...READY, newGate: true } }),
  () => ({ ready: true, checks: { authentication: true } }),
])("requires every current readiness check without silently accepting changed gates", async (change) => {
  const r = await run(fixture({ mutate: (p, body) => p === 1 ? change(body) : body }));
  expect(r.checks.at(-1)).toMatchObject({ phase: "readiness", passed: false, failure: "response" });
});

it.each([
  { decision: "hold" }, { uncertain: true }, { degraded: { reason: "classifier_unavailable" } }, { receipt: null }, { requestId: "wrong-request" },
  { shadow: { decision: "block", reasonCodes: [] } }, { policyRevision: "another-revision" },
])("refuses a benign smoke result that fails classifier/identity acceptance (%o)", async (change) => {
  const r = await run(fixture({ mutate: (p, body) => p === 2 ? { ...(body as object), ...change } : body }));
  expect(r.checks.at(-1)).toMatchObject({ phase: "evaluation", passed: false, failure: "response" });
});

it("refuses a changed replay, a missing replay header, and cross-tenant or expired receipts", async () => {
  for (const f of [
    fixture({ mutate: (p, body) => p === 3 ? { ...(body as object), evaluationId: "eval_other" } : body }),
    fixture({ headers: (p) => p === 3 ? { "idempotent-replayed": "false" } : {} }),
    fixture({ mutate: (p, body) => p === 4 ? { ...(body as object), tenantId: "another-tenant" } : body }),
    fixture({ mutate: (p, body) => p === 4 ? { ...(body as object), expiresAt: new Date(NOW).toISOString() } : body }),
  ]) expect((await run(f)).passed).toBe(false);
});

it.each([301, 401, 409, 503])("does not follow or retry HTTP %i and does not copy upstream errors", async (status) => {
  const f = fixture({ status: (p) => p === 1 ? status : 200, raw: (p) => p === 1 ? "SYNTHETIC-PRIVATE-UPSTREAM" : undefined });
  const r = await run(f);
  expect(r.passed).toBe(false); expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(r)).not.toContain("PRIVATE-UPSTREAM");
});

it("bounds malformed/oversized responses and sanitizes transport exceptions", async () => {
  for (const f of [fixture({ raw: (p) => p === 1 ? "not-json" : undefined }), fixture({ raw: (p) => p === 1 ? '"' + "x".repeat(300_000) + '"' : undefined }), fixture({ fail: 1 })]) {
    const r = await run(f); expect(r.passed).toBe(false); expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("PRIVATE-UPSTREAM");
  }
});

it("detects escaped sentinel reflection before publishing evidence or making a replay", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ mutate: (p, body) => {
    if (p !== 2) return body;
    const input = JSON.parse(f.requests[2]!.init.body as string) as { content: { text: string } };
    return { ...(body as object), reflected: input.content.text };
  } });
  const r = await run(f);
  expect(r.checks.at(-1)).toMatchObject({ phase: "evaluation", passed: false, failure: "content-reflected" });
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(r)).not.toContain("SYNTHETIC-ACCEPTANCE");
});

it("requires synthetic, distinct, unexpired tenant-matching credentials before sending anything", async () => {
  const bad = [
    { ...credentials(), mode: "real" }, { ...credentials(), extra: true },
    { ...credentials(), tokens: { ...credentials().tokens, evaluate: credentials().tokens.ready } },
    ...[{ tenant: "other" }, { exp: NOW / 1000 }, { exp: NOW / 1000 + 301 }, { scope: "receipts:read" }].map((change) => ({ ...credentials(), tokens: { ...credentials().tokens, evaluate: token(change) } })),
  ];
  for (const value of bad) expect(() => parseSyntheticAcceptanceCredentials(value, NOW)).toThrow();
  const f = fixture(); await expect(run(f, bad[0]!)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
});

it.each(["http://synthetic.test", "https://user:pass@synthetic.test", "https://synthetic.test/path", "https://synthetic.test/?token=secret"])("rejects an unsuitable target before attaching credentials (%s)", (url) => {
  expect(() => validateAcceptanceTarget({ ...TARGET, url })).toThrow();
});
