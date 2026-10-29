import { CLEF_CLASSIFIER_VERSION, createClefClassifier, workersAiBindingTransport } from "@gmacko/hall-monitor-clef";
import { authorizeModelTransfer } from "@gmacko/hall-monitor-governance";
import { loadDecisionQuestions } from "./decision-packs.ts";
import {
  BATCH_EVALUATION_KINDS,
  ContentType,
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
import { AuthError, bearerToken, CLOCK_SKEW_SECONDS, SCOPE_EVALUATE, SCOPE_RECEIPTS_READ, type ServiceIdentity, verifyServiceToken } from "./auth.ts";
import { type Config, enforcementFor, loadConfig, lookupPolicy, tenantProfiles } from "./config.ts";
import { requestDigest } from "./digest.ts";
import type { Env } from "./env.ts";
import { errorResponse, HttpError, json, readJson } from "./http.ts";
import { log } from "./log.ts";
import { prepareTelemetryDelivery, scheduleEvaluationMetrics } from "./metrics.ts";
import { openApiJson } from "./openapi.ts";
import { replayGuardName } from "./replay.ts";

/**
 * Largest single-evaluation body: up to 8 MiB of images (about 10.7 MiB as base64) plus 32k UTF-16
 * units of text and an answer key, with headroom. It also keeps the Clef request under Clef's
 * 13 MiB body limit.
 */
export const MAX_EVALUATION_BYTES = 12 * 1024 * 1024;
/** Largest batch body. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
/** Batch items evaluated concurrently. */
export const BATCH_CONCURRENCY = 4;

/** Handles one HTTP request. Every failure becomes a content-free wire error. */
export async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const route = routeOf(request.method, url.pathname);
  try {
    switch (route.name) {
      case "health":
        return json({ status: "ok" });
      case "openapi":
        return new Response(openApiJson(), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
      case "ready":
        return await ready(request, env);
      case "capabilities":
        return await capabilities(request, env);
      case "evaluate":
        return await evaluateOne(request, env, ctx);
      case "batch":
        return await evaluateBatch(request, env, ctx);
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
  | { readonly name: "health" | "openapi" | "ready" | "capabilities" | "evaluate" | "batch" | "method_not_allowed" | "not_found" }
  | { readonly name: "receipt"; readonly evaluationId: string };

function routeOf(method: string, path: string): Route {
  const want = (expected: string, name: "health" | "openapi" | "ready" | "capabilities" | "evaluate" | "batch"): Route =>
    method === expected ? { name } : { name: "method_not_allowed" };
  switch (path) {
    case "/v1/health":
      return want("GET", "health");
    case "/v1/openapi.json":
      return want("GET", "openapi");
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

/**
 * Verifies the bearer token, claims its `jti` so the token cannot be presented again and, when
 * given, checks that it grants `scope`. A replayed token is `401 unauthorized` and not retryable:
 * a client retry must mint a new token.
 */
async function authenticate(request: Request, env: Env, config: Config, scope?: string): Promise<ServiceIdentity> {
  if (config.issuers === undefined) throw new HttpError("unavailable", "service authentication is not configured");
  if (env.TOKEN_REPLAY_GUARD === undefined) throw new HttpError("unavailable", "service authentication is not configured");
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
  const guard = env.TOKEN_REPLAY_GUARD.get(env.TOKEN_REPLAY_GUARD.idFromName(replayGuardName(identity.issuer, identity.tenant)));
  let firstUse: boolean;
  try {
    firstUse = await guard.claim(identity.issuer, identity.tokenId, (identity.expiresAt + CLOCK_SKEW_SECONDS) * 1000);
  } catch (error) {
    log("error", "replay_guard.unavailable", { tenant: identity.tenant, errorName: errorName(error) });
    throw new HttpError("unavailable", "service authentication is unavailable", { retryable: true });
  }
  if (!firstUse) {
    log("info", "auth.rejected", { tenant: identity.tenant, authFailure: "replayed", status: 401 });
    throw new HttpError("unauthorized", "a valid service token is required");
  }
  if (scope !== undefined && !identity.scopes.has(scope)) {
    throw new HttpError("forbidden", `token lacks the ${scope} scope`);
  }
  return identity;
}

async function ready(request: Request, env: Env): Promise<Response> {
  const config = loadConfig(env);
  await authenticate(request, env, config);
  const checks = {
    authentication: config.issuers !== undefined && (config.audience !== undefined || config.issuers.every((issuer) => issuer.audiences !== undefined)),
    policyOverlays: config.overlays !== undefined,
    tenantModes: config.tenantModes !== undefined,
    idempotencyStore: env.IDEMPOTENCY_STORE !== undefined,
    replayGuard: env.TOKEN_REPLAY_GUARD !== undefined,
    // Presence and shape only: readiness never makes a billed model call.
    classifier: typeof env.AI?.run === "function",
    decisionPack: await loadDecisionQuestions(env) !== undefined,
    governanceConfig: config.governance !== undefined,
  };
  const isReady = Object.values(checks).every(Boolean);
  return json({ ready: isReady, checks }, isReady ? 200 : 503);
}

async function capabilities(request: Request, env: Env): Promise<Response> {
  const config = loadConfig(env);
  const identity = await authenticate(request, env, config);
  const classifierEnabled = env.AI !== undefined && config.governance !== undefined && await loadDecisionQuestions(env) !== undefined;
  const body: Capabilities = {
    schemaVersion: SCHEMA_VERSION,
    supportedSchemaVersions: [...SUPPORTED_SCHEMA_VERSIONS],
    evaluationKinds: [...EvaluationKind.options],
    evaluatorBundles: [{ id: defaultBundle.id, revision: bundleRevision(classifierEnabled) }],
    policyProfiles: config.overlays === undefined ? [] : tenantProfiles(config, identity.tenant),
    resolverVersion: RESOLVER_VERSION,
    classifier: { enabled: classifierEnabled, models: classifierEnabled ? [CLEF_FLASH_MODEL, CLEF_MODEL] : [] },
    contentTypes: [...ContentType.options],
  };
  return json(body);
}

async function evaluateOne(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const config = loadConfig(env);
  const identity = await authenticate(request, env, config, SCOPE_EVALUATE);
  const parsed = parseOrThrow(await readJson(request, MAX_EVALUATION_BYTES));
  assertTenant(identity, parsed);
  const outcome = await runEvaluation(parsed, identity, config, env, ctx);
  if ("error" in outcome) throw outcome.error;
  return json(outcome.result, 200, outcome.replayed ? { "idempotent-replayed": "true" } : {});
}

async function evaluateBatch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const config = loadConfig(env);
  const identity = await authenticate(request, env, config, SCOPE_EVALUATE);
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
      const outcome = await runEvaluation(parsed, identity, config, env, ctx);
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
  const identity = await authenticate(request, env, loadConfig(env), SCOPE_RECEIPTS_READ);
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
async function runEvaluation(request: EvaluationRequest, identity: ServiceIdentity, config: Config, env: Env, ctx?: ExecutionContext): Promise<Outcome> {
  const started = Date.now();
  const tenant = identity.tenant;
  const fail = (error: HttpError): Outcome => {
    log("info", "evaluation.failed", { tenant, errorCode: error.body.code, status: error.status, latencyMs: Date.now() - started });
    return { error };
  };
  if (config.overlays === undefined) return fail(new HttpError("unavailable", "policy configuration is invalid"));

  if (env.HM_DIGEST_KEY === undefined || env.HM_DIGEST_KEY.length < 32) return fail(new HttpError("unavailable", "request digest key is not configured"));

  const store = storeFor(env, tenant);
  const digest = await requestDigest(request, env.HM_DIGEST_KEY);
  const begun = await store.begin(request.idempotencyKey, digest);
  switch (begun.kind) {
    case "replay":
      log("info", "evaluation.replayed", {
        tenant,
        evaluationId: begun.result.evaluationId,
        decision: begun.result.decision,
        ...shadowFields(begun.result),
        latencyMs: Date.now() - started,
      });
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
      ...(await classifierFor(env, request, identity, config)),
      priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      clock: () => new Date(),
      ids: { evaluationId: () => newId("eval"), receiptId: () => newId("rcpt") },
      // Enrollment cannot turn denied classification into an allow through an old shadow override.
      enforcement: config.governance === undefined || Object.hasOwn(config.governance.tenants, tenant)
        ? { mode: "enforce" }
        : enforcementFor(config, tenant, (profile) => log("warn", "shadow.refused", { tenant, profileId: profile.id })),
    });
  } catch (error) {
    await store.abandonReserved(request.idempotencyKey, digest, begun.reservationId);
    if (error instanceof HttpError) return fail(error);
    if (error instanceof HallMonitorError) return fail(new HttpError(error.body.code, error.body.message, { retryable: error.body.retryable }));
    log("error", "internal.error", { tenant, route: "evaluate", errorName: errorName(error) });
    return fail(new HttpError("unavailable", "evaluation failed", { retryable: true }));
  }

  // The v2 delivery is projected before completion so the store commits it with the result and
  // receipt in one transaction. Disabled (the default), it is null and nothing changes.
  const telemetry = await prepareTelemetryDelivery(env, tenant, request, result);
  const committed = await store.completeReserved(request.idempotencyKey, digest, begun.reservationId, result, {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: result.evaluationId,
    requestId: result.requestId,
    tenantId: tenant,
    receipt: result.receipt,
    recordedAt: new Date().toISOString(),
  }, telemetry ?? undefined);
  if (committed === null) return fail(new HttpError("idempotency_conflict", "evaluation reservation is no longer current", { retryable: true }));
  log("info", "evaluation.completed", {
    tenant,
    evaluationId: result.evaluationId,
    decision: result.decision,
    ...shadowFields(result),
    attempts: result.receipt?.attempts.length ?? 0,
    latencyMs: Date.now() - started,
    ...(result.degraded === undefined ? {} : { degraded: result.degraded.reason }),
  });
  // Opt-in, content-free event emission. Never called on replay, failure or an
  // uncommitted evaluation; send is isolated by ctx.waitUntil.
  scheduleEvaluationMetrics(env, tenant, request, result, ctx);
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

async function classifierFor(env: Env, request: EvaluationRequest, identity: ServiceIdentity, config: Config) {
  if (env.AI === undefined) return {};
  const questions = await loadDecisionQuestions(env);
  if (questions === undefined) return {};
  const gatewayId = env.HM_AI_GATEWAY_ID === undefined || env.HM_AI_GATEWAY_ID === "" ? undefined : env.HM_AI_GATEWAY_ID;
  const authorizeModel = (modelId: string): boolean => {
    const decision = authorizeModelTransfer(config.governance, {
      tenant: identity.tenant, issuer: identity.issuer, context: identity.governance,
      requestId: request.requestId, product: request.source.product, surface: request.source.surface,
      evaluationKind: request.evaluationKind, modelId, gatewayId, sourceRevision: env.FG_COMMIT_HASH,
      accountId: env.HM_GOVERNANCE_ACCOUNT_ID, workerName: env.HM_GOVERNANCE_WORKER_NAME,
      now: Math.floor(Date.now() / 1000),
    });
    if (!decision.allowed) log("warn", "governance.denied", { reason: decision.reason });
    return decision.allowed;
  };
  if (!authorizeModel(CLEF_FLASH_MODEL)) return {};
  const gateway =
    gatewayId === undefined
      ? undefined
      : { id: gatewayId, metadata: { tenant: request.source.tenantId, product: request.source.product, kind: request.evaluationKind },
        ...(config.governance !== undefined && Object.hasOwn(config.governance.tenants, identity.tenant) ? { skipCache: true, collectLog: false } : {}) };
  return {
    classifier: createClefClassifier({
      transport: workersAiBindingTransport(env.AI, gateway),
      priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
      newAttemptId: () => newId("att"),
      questions: questions.text,
      imageQuestions: questions.image,
      authorizeModel,
    }),
  };
}

/** Content-free log fields recording a shadow-mode result's would-be decision. */
function shadowFields(result: EvaluationResult) {
  return result.shadow === undefined ? {} : { mode: "shadow" as const, shadowDecision: result.shadow.decision };
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
