import { CLEF_CLASSIFIER_VERSION, createClefClassifier, workersAiBindingTransport } from "@gmacko/hall-monitor-clef";
import {
  BATCH_EVALUATION_KINDS,
  type BatchEvaluationItem,
  type BatchEvaluationResponse,
  type Capabilities,
  type EvaluationRequest,
  type EvaluationResult,
  EvaluationKind,
  MAX_BATCH_SIZE,
  OpaqueId,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} from "@gmacko/hall-monitor-contracts";
import { evaluate, HallMonitorError, parseEvaluationRequest } from "@gmacko/hall-monitor-core";
import { CLEF_FLASH_MODEL, CLEF_MODEL, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { defaultBundle } from "@gmacko/hall-monitor-evaluators";
import { RESOLVER_VERSION } from "@gmacko/hall-monitor-policy";
import { AuthError, bearerToken, SCOPE_EVALUATE, SCOPE_RECEIPTS_READ, type ServiceIdentity, verifyServiceToken } from "./auth.ts";
import { type Config, loadConfig, lookupPolicy, tenantProfiles } from "./config.ts";
import { requestDigest } from "./digest.ts";
import type { Env } from "./env.ts";
import { errorResponse, HttpError, json, readJson } from "./http.ts";
import { log } from "./log.ts";

/** Largest single-evaluation body: 32k UTF-16 units of text plus an answer key, with headroom. */
export const MAX_EVALUATION_BYTES = 512 * 1024;
/** Largest batch body. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
/** Batch items evaluated concurrently. */
export const BATCH_CONCURRENCY = 4;

/** Handles one HTTP request. Every failure becomes a content-free wire error. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = routeOf(request.method, url.pathname);
  try {
    switch (route.name) {
      case "health":
        return json({ status: "ok" });
      case "ready":
        return await ready(request, env);
      case "capabilities":
        return await capabilities(request, env);
      case "evaluate":
        return await evaluateOne(request, env);
      case "batch":
        return await evaluateBatch(request, env);
      case "receipt":
        return await readReceipt(request, env, route.evaluationId);
      case "method_not_allowed":
        throw new HttpError("invalid_request", "method not allowed", { status: 405 });
      case "not_found":
        throw new HttpError("invalid_request", "no such route", { status: 404 });
    }
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 400 && error.status !== 401) log("info", "request.rejected", { route: route.name, status: error.status, errorCode: error.body.code });
      return errorResponse(error);
    }
    log("error", "internal.error", { route: route.name, errorName: errorName(error) });
    return errorResponse(new HttpError("unavailable", "internal error", { retryable: true }));
  }
}

type Route =
  | { readonly name: "health" | "ready" | "capabilities" | "evaluate" | "batch" | "method_not_allowed" | "not_found" }
  | { readonly name: "receipt"; readonly evaluationId: string };

function routeOf(method: string, path: string): Route {
  const want = (expected: string, name: "health" | "ready" | "capabilities" | "evaluate" | "batch"): Route =>
    method === expected ? { name } : { name: "method_not_allowed" };
  switch (path) {
    case "/v1/health":
      return want("GET", "health");
    case "/v1/ready":
      return want("GET", "ready");
    case "/v1/capabilities":
      return want("GET", "capabilities");
    case "/v1/evaluations":
      return want("POST", "evaluate");
    case "/v1/evaluations:batch":
      return want("POST", "batch");
  }
  const receipt = /^\/v1\/receipts\/([^/]+)$/.exec(path);
  if (receipt !== null) return method === "GET" ? { name: "receipt", evaluationId: receipt[1]! } : { name: "method_not_allowed" };
  return { name: "not_found" };
}

/** Verifies the bearer token and, when given, that it grants `scope`. */
async function authenticate(request: Request, config: Config, scope?: string): Promise<ServiceIdentity> {
  if (config.issuers === undefined) throw new HttpError("unavailable", "service authentication is not configured");
  let identity: ServiceIdentity;
  try {
    identity = await verifyServiceToken(bearerToken(request.headers.get("authorization")), {
      issuers: config.issuers,
      audience: config.audience,
      now: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    const authFailure = error instanceof AuthError ? error.reason : "malformed_token";
    log("info", "auth.rejected", { authFailure, status: 401 });
    throw new HttpError("unauthorized", "a valid service token is required");
  }
  if (scope !== undefined && !identity.scopes.has(scope)) {
    throw new HttpError("forbidden", `token lacks the ${scope} scope`);
  }
  return identity;
}

async function ready(request: Request, env: Env): Promise<Response> {
  const config = loadConfig(env);
  await authenticate(request, config);
  const checks = {
    authentication: config.issuers !== undefined && (config.audience !== undefined || config.issuers.every((issuer) => issuer.audiences !== undefined)),
    policyOverlays: config.overlays !== undefined,
    idempotencyStore: env.IDEMPOTENCY_STORE !== undefined,
    // Presence and shape only: readiness never makes a billed model call.
    classifier: typeof env.AI?.run === "function",
  };
  const isReady = Object.values(checks).every(Boolean);
  return json({ ready: isReady, checks }, isReady ? 200 : 503);
}

async function capabilities(request: Request, env: Env): Promise<Response> {
  const config = loadConfig(env);
  const identity = await authenticate(request, config);
  const classifierEnabled = env.AI !== undefined;
  const body: Capabilities = {
    schemaVersion: SCHEMA_VERSION,
    supportedSchemaVersions: [...SUPPORTED_SCHEMA_VERSIONS],
    evaluationKinds: [...EvaluationKind.options],
    evaluatorBundles: [{ id: defaultBundle.id, revision: bundleRevision(classifierEnabled) }],
    policyProfiles: config.overlays === undefined ? [] : tenantProfiles(config, identity.tenant),
    resolverVersion: RESOLVER_VERSION,
    classifier: { enabled: classifierEnabled, models: classifierEnabled ? [CLEF_FLASH_MODEL, CLEF_MODEL] : [] },
  };
  return json(body);
}

async function evaluateOne(request: Request, env: Env): Promise<Response> {
  const config = loadConfig(env);
  const identity = await authenticate(request, config, SCOPE_EVALUATE);
  const parsed = parseOrThrow(await readJson(request, MAX_EVALUATION_BYTES));
  assertTenant(identity, parsed);
  const outcome = await runEvaluation(parsed, identity, config, env);
  if ("error" in outcome) throw outcome.error;
  return json(outcome.result, 200, outcome.replayed ? { "idempotent-replayed": "true" } : {});
}

async function evaluateBatch(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const config = loadConfig(env);
  const identity = await authenticate(request, config, SCOPE_EVALUATE);
  const body = await readJson(request, MAX_BATCH_BYTES);
  const items = typeof body === "object" && body !== null ? (body as { requests?: unknown }).requests : undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH_SIZE) {
    throw new HttpError("invalid_request", `requests must be an array of 1 to ${MAX_BATCH_SIZE} evaluations`);
  }
  const requests = items.map((item, index) => {
    try {
      return parseOrThrow(item);
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.body.code, `requests.${index}: ${error.body.message}`);
      throw error;
    }
  });
  if (requests.some((parsed) => !(BATCH_EVALUATION_KINDS as readonly string[]).includes(parsed.evaluationKind))) {
    throw new HttpError("invalid_request", "batches accept content.candidate and assessment.evaluator-result only");
  }
  for (const parsed of requests) assertTenant(identity, parsed);
  if (new Set(requests.map((parsed) => parsed.idempotencyKey)).size !== requests.length) {
    throw new HttpError("invalid_request", "idempotency keys must be unique within a batch");
  }

  const results: BatchEvaluationItem[] = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < requests.length; index = next++) {
      const parsed = requests[index]!;
      const outcome = await runEvaluation(parsed, identity, config, env);
      results[index] = "error" in outcome ? { status: "error", requestId: parsed.requestId, error: outcome.error.body } : { status: "ok", result: outcome.result };
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, requests.length) }, worker));
  const errors = results.filter((item) => item.status === "error").length;
  log("info", "batch.completed", { tenant: identity.tenant, items: requests.length, errors, latencyMs: Date.now() - started });
  const response: BatchEvaluationResponse = { schemaVersion: SCHEMA_VERSION, items: results };
  return json(response);
}

async function readReceipt(request: Request, env: Env, rawId: string): Promise<Response> {
  const identity = await authenticate(request, loadConfig(env), SCOPE_RECEIPTS_READ);
  let evaluationId: string;
  try {
    evaluationId = decodeURIComponent(rawId);
  } catch {
    throw new HttpError("invalid_request", "invalid evaluation id");
  }
  if (!OpaqueId.safeParse(evaluationId).success) throw new HttpError("invalid_request", "invalid evaluation id");
  // The store is the caller's own tenant's: another tenant's evaluation id is simply not found.
  const record = await storeFor(env, identity.tenant).receipt(evaluationId);
  if (record === null) throw new HttpError("invalid_request", "receipt not found", { status: 404 });
  log("info", "receipt.read", { tenant: identity.tenant, evaluationId });
  return json(record);
}

type Outcome = { readonly result: EvaluationResult; readonly replayed: boolean } | { readonly error: HttpError };

/**
 * Evaluates one validated, tenant-checked request under its idempotency key: a completed key with
 * the same request digest replays the stored result without evaluating (or billing) again, and a
 * reused key with a different digest is a conflict.
 */
async function runEvaluation(request: EvaluationRequest, identity: ServiceIdentity, config: Config, env: Env): Promise<Outcome> {
  const started = Date.now();
  const tenant = identity.tenant;
  const fail = (error: HttpError): Outcome => {
    log("info", "evaluation.failed", { tenant, errorCode: error.body.code, status: error.status, latencyMs: Date.now() - started });
    return { error };
  };
  if (config.overlays === undefined) return fail(new HttpError("unavailable", "policy configuration is invalid"));

  const store = storeFor(env, tenant);
  const digest = await requestDigest(request);
  const begun = await store.begin(request.idempotencyKey, digest);
  switch (begun.kind) {
    case "replay":
      log("info", "evaluation.replayed", { tenant, evaluationId: begun.result.evaluationId, decision: begun.result.decision, latencyMs: Date.now() - started });
      return { result: begun.result, replayed: true };
    case "conflict":
      return fail(new HttpError("idempotency_conflict", "idempotency key was already used for a different request"));
    case "in_progress":
      return fail(new HttpError("idempotency_conflict", "a request with this idempotency key is in progress", { retryable: true }));
    case "started":
      break;
  }

  let result: EvaluationResult;
  try {
    await admit(env, tenant);
    result = await evaluate(request, {
      policies: (profileId, revision) => lookupPolicy(config, tenant, profileId, revision),
      bundle: defaultBundle,
      ...classifierFor(env, request),
      priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      clock: () => new Date(),
      ids: { evaluationId: () => newId("eval"), receiptId: () => newId("rcpt") },
    });
  } catch (error) {
    await store.abandon(request.idempotencyKey, digest);
    if (error instanceof HttpError) return fail(error);
    if (error instanceof HallMonitorError) return fail(new HttpError(error.body.code, error.body.message, { retryable: error.body.retryable }));
    log("error", "internal.error", { tenant, route: "evaluate", errorName: errorName(error) });
    return fail(new HttpError("unavailable", "evaluation failed", { retryable: true }));
  }

  await store.complete(request.idempotencyKey, digest, result, {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: result.evaluationId,
    requestId: result.requestId,
    tenantId: tenant,
    receipt: result.receipt,
    recordedAt: new Date().toISOString(),
  });
  log("info", "evaluation.completed", {
    tenant,
    evaluationId: result.evaluationId,
    decision: result.decision,
    attempts: result.receipt?.attempts.length ?? 0,
    latencyMs: Date.now() - started,
    ...(result.degraded === undefined ? {} : { degraded: result.degraded.reason }),
  });
  return { result, replayed: false };
}

/** Applies the per-tenant rate limit when the binding exists. A limiter outage does not block evaluation. */
async function admit(env: Env, tenant: string): Promise<void> {
  if (env.TENANT_RATE_LIMITER === undefined) return;
  let success: boolean;
  try {
    ({ success } = await env.TENANT_RATE_LIMITER.limit({ key: tenant }));
  } catch (error) {
    log("warn", "ratelimit.unavailable", { tenant, errorName: errorName(error) });
    return;
  }
  if (!success) throw new HttpError("rate_limited", "tenant request rate exceeded", { retryable: true, headers: { "retry-after": "10" } });
}

function classifierFor(env: Env, request: EvaluationRequest) {
  if (env.AI === undefined) return {};
  const gatewayId = env.HM_AI_GATEWAY_ID === undefined || env.HM_AI_GATEWAY_ID === "" ? undefined : env.HM_AI_GATEWAY_ID;
  const gateway =
    gatewayId === undefined
      ? undefined
      : { id: gatewayId, metadata: { tenant: request.source.tenantId, product: request.source.product, kind: request.evaluationKind } };
  return {
    classifier: createClefClassifier({
      transport: workersAiBindingTransport(env.AI, gateway),
      priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      newAttemptId: () => newId("att"),
    }),
  };
}

function parseOrThrow(input: unknown): EvaluationRequest {
  try {
    return parseEvaluationRequest(input);
  } catch (error) {
    if (error instanceof HallMonitorError) throw new HttpError(error.body.code, error.body.message);
    throw error;
  }
}

/** The request's tenant must be the token's: a service can never act for another tenant. */
function assertTenant(identity: ServiceIdentity, request: EvaluationRequest): void {
  if (request.source.tenantId !== identity.tenant) throw new HttpError("forbidden", "source.tenantId does not match the service token");
}

function storeFor(env: Env, tenant: string) {
  return env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName(`tenant:${tenant}`));
}

/** The evaluator bundle revision results carry, matching the core's composition. */
function bundleRevision(classifierEnabled: boolean): string {
  return classifierEnabled ? `${defaultBundle.revision}:clef-${CLEF_CLASSIFIER_VERSION}` : defaultBundle.revision;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : typeof error;
}
