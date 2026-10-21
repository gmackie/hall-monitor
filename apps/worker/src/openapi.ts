import {
  BatchEvaluationRequest,
  BatchEvaluationResponse,
  Capabilities,
  CostReceipt,
  ErrorBody,
  EvaluationContent,
  EvaluationRequest,
  EvaluationResult,
  Finding,
  ReceiptRecord,
  SCHEMA_VERSION,
  UsageAttempt,
} from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/** The body of `GET /v1/health`. */
export const HealthResponse = z.object({ status: z.literal("ok") });

/** The body of `GET /v1/ready`: an overall verdict and one boolean per configuration check. */
export const ReadyResponse = z.object({
  ready: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
});

/**
 * Every schema published under `components.schemas`, by name. Each one is the zod contract the
 * Worker itself parses with, so the document cannot describe a shape the service does not accept.
 */
const COMPONENTS = {
  EvaluationRequest,
  EvaluationContent,
  EvaluationResult,
  Finding,
  CostReceipt,
  UsageAttempt,
  BatchEvaluationRequest,
  BatchEvaluationResponse,
  Capabilities,
  ReceiptRecord,
  ErrorBody,
  HealthResponse,
  ReadyResponse,
} satisfies Record<string, z.ZodType>;

type ComponentName = keyof typeof COMPONENTS;

const ref = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (name: ComponentName, description: string) => ({ description, content: { "application/json": { schema: ref(name) } } });
const error = (description: string) => jsonBody("ErrorBody", description);

/** Error responses every authenticated route can return. */
const AUTHENTICATED_ERRORS = {
  "401": error("Missing, invalid, expired or already-used service token (`unauthorized`, not retryable with the same token)."),
  "429": error("The tenant's request rate was exceeded (`rate_limited`); honor `Retry-After`."),
  "503": error("Service misconfigured or a dependency failed (`unavailable`)."),
};

const EVALUATION_ERRORS = {
  "400": error("Invalid body or unsupported schema version (`invalid_request`, `unsupported_schema`). Messages name fields, never values."),
  "403": error("The token lacks the `evaluate` scope, or `source.tenantId` is not the token's tenant (`forbidden`)."),
  "413": error("The body exceeds the size limit (`invalid_request`)."),
  ...AUTHENTICATED_ERRORS,
};

/**
 * Builds the OpenAPI 3.1 document for the Worker API. Component schemas are generated from the
 * wire contracts with `z.toJSONSchema` (JSON Schema 2020-12, which OpenAPI 3.1 uses natively) in
 * input mode, so they describe what the service accepts: unknown object members are allowed and
 * ignored. The output is deterministic, so the committed `apps/worker/openapi.json` can be
 * checked for drift (`pnpm openapi:check`).
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(COMPONENTS)) registry.add(schema as z.ZodType, { id });
  const generated = z.toJSONSchema(registry, { io: "input", uri: (id) => `#/components/schemas/${id}` });
  const schemas = Object.fromEntries(
    Object.keys(COMPONENTS).map((name) => {
      const { $schema: _schema, $id: _id, ...schema } = generated.schemas[name] as Record<string, unknown>;
      return [name, schema];
    }),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: "Hall Monitor API",
      version: SCHEMA_VERSION,
      summary: "Product-neutral moderation and evaluation for SchoolOS and PlayTrek.",
      description:
        "Evaluates content or requested activity under a pinned policy revision and returns findings, a decision and a content-free cost receipt. `info.version` is the wire schema version. Responses never echo request content.",
    },
    servers: [{ url: "/", description: "The deployment serving this document." }],
    security: [{ serviceToken: [] }],
    paths: {
      "/v1/evaluations": {
        post: {
          operationId: "evaluate",
          summary: "Evaluate one request",
          description:
            "Requires the `evaluate` scope. Idempotent by `idempotencyKey`: repeating a completed request replays the stored result without re-evaluating or re-billing (response header `idempotent-replayed: true`); reusing a key for a different request is `409 idempotency_conflict`.",
          requestBody: { required: true, content: { "application/json": { schema: ref("EvaluationRequest") } } },
          responses: {
            "200": {
              ...jsonBody("EvaluationResult", "The evaluation result."),
              headers: { "idempotent-replayed": { description: "`true` when the stored result was replayed.", schema: { type: "string", enum: ["true"] } } },
            },
            "404": error("The pinned policy revision is not available to this tenant (`policy_not_found`)."),
            "409": error("The idempotency key was used for a different request, or the same request is in flight (`idempotency_conflict`)."),
            ...EVALUATION_ERRORS,
          },
        },
      },
      "/v1/evaluations:batch": {
        post: {
          operationId: "evaluateBatch",
          summary: "Evaluate up to 50 offline requests",
          description:
            "Requires the `evaluate` scope. Accepts `content.candidate` and `assessment.evaluator-result` only; idempotency keys must be unique within the batch. Each item succeeds or fails on its own, in request order.",
          requestBody: { required: true, content: { "application/json": { schema: ref("BatchEvaluationRequest") } } },
          responses: { "200": jsonBody("BatchEvaluationResponse", "One item per request, in order."), ...EVALUATION_ERRORS },
        },
      },
      "/v1/capabilities": {
        get: {
          operationId: "capabilities",
          summary: "Describe the deployment",
          description: "Any valid token. Supported versions, kinds, bundles, the classifier and the caller tenant's pinnable profile revisions.",
          responses: { "200": jsonBody("Capabilities", "What this deployment supports."), ...AUTHENTICATED_ERRORS },
        },
      },
      "/v1/receipts/{evaluationId}": {
        get: {
          operationId: "receipt",
          summary: "Read a receipt record",
          description: "Requires the `receipts:read` scope. Only the caller tenant's records are visible; another tenant's id is not found.",
          parameters: [{ name: "evaluationId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } }],
          responses: {
            "200": jsonBody("ReceiptRecord", "The stored receipt record."),
            "400": error("The evaluation id is malformed (`invalid_request`)."),
            "403": error("The token lacks the `receipts:read` scope (`forbidden`)."),
            "404": error("No record for this tenant, or it expired (`invalid_request`)."),
            ...AUTHENTICATED_ERRORS,
          },
        },
      },
      "/v1/ready": {
        get: {
          operationId: "ready",
          summary: "Readiness",
          description: "Any valid token. Configuration and binding checks; never makes a billed call.",
          responses: {
            "200": jsonBody("ReadyResponse", "Every check passed."),
            "401": AUTHENTICATED_ERRORS["401"],
            "503": jsonBody("ReadyResponse", "At least one check failed (or an `ErrorBody` when authentication is not configured)."),
          },
        },
      },
      "/v1/health": {
        get: {
          operationId: "health",
          summary: "Liveness",
          description: "Public. Reveals nothing tenant-specific.",
          security: [],
          responses: { "200": jsonBody("HealthResponse", "The Worker is running.") },
        },
      },
      "/v1/openapi.json": {
        get: {
          operationId: "openapi",
          summary: "This document",
          description: "Public.",
          security: [],
          responses: { "200": { description: "The OpenAPI 3.1 document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
    components: {
      securitySchemes: {
        serviceToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "A service JWT signed with EdDSA (Ed25519) or ES256 by an issuer in `HM_TRUSTED_ISSUERS`, carrying `iss`, `aud`, `exp` (at most one hour ahead), optional `nbf`/`iat` (60 s skew), `jti`, `tenant` and `scope` (space-separated: `evaluate`, `receipts:read`). Each token is accepted once: a replayed `(iss, jti)` is `401 unauthorized`, so mint a new token for every request and every retry.",
        },
      },
      schemas,
    },
  };
}

let cached: string | undefined;

/** The document serialized as the Worker serves it and as `openapi.json` is committed. */
export function openApiJson(): string {
  cached ??= `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  return cached;
}
