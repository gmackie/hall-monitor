import { z } from "zod";
import { Decision, EvaluationKind, MachineCode, OpaqueId, Product, Timestamp } from "./primitives.ts";
import { ContentType, EvaluationContext, EvaluationRequest, PolicyRef } from "./request.ts";
import { EnforcementMode, ErrorBody, EvaluationResult } from "./result.ts";
import { CostReceipt } from "./usage.ts";
import { SchemaVersion } from "./version.ts";

/** The most requests one batch call accepts. */
export const MAX_BATCH_SIZE = 50;

/**
 * Kinds a batch may carry. Interactive moderation (`interaction.*`) is latency-critical and
 * blocks a live user, so it is always evaluated one request at a time.
 */
export const BATCH_EVALUATION_KINDS = ["content.candidate", "assessment.evaluator-result"] as const satisfies readonly EvaluationKind[];

/** The body of `POST /v1/evaluations:batch`: up to {@link MAX_BATCH_SIZE} offline evaluations. */
export const BatchEvaluationRequest = z.object({
  requests: z
    .array(EvaluationRequest)
    .min(1)
    .max(MAX_BATCH_SIZE)
    .refine((requests) => requests.every((request) => (BATCH_EVALUATION_KINDS as readonly string[]).includes(request.evaluationKind)), {
      message: "batches accept content.candidate and assessment.evaluator-result only",
    }),
});
/** The body of `POST /v1/evaluations:batch`. */
export type BatchEvaluationRequest = z.infer<typeof BatchEvaluationRequest>;

/** One batch item's outcome: a result, or the error that request alone would have returned. */
export const BatchEvaluationItem = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: EvaluationResult }),
  z.object({ status: z.literal("error"), requestId: OpaqueId, error: ErrorBody }),
]);
/** One batch item's outcome. */
export type BatchEvaluationItem = z.infer<typeof BatchEvaluationItem>;

/** The response to a batch call: one item per request, in request order. */
export const BatchEvaluationResponse = z.object({
  schemaVersion: SchemaVersion,
  items: z.array(BatchEvaluationItem).max(MAX_BATCH_SIZE),
});
/** The response to a batch call. */
export type BatchEvaluationResponse = z.infer<typeof BatchEvaluationResponse>;

/**
 * A stored evaluation's cost record, as returned by `GET /v1/receipts/{evaluationId}`. It is
 * content-free: identifiers, the decision's receipt and when it was recorded.
 */
export const ReceiptRecord = z.object({
  schemaVersion: SchemaVersion,
  evaluationId: OpaqueId,
  requestId: OpaqueId,
  tenantId: OpaqueId,
  /** Null when the evaluation made no billable provider attempt. */
  receipt: CostReceipt.nullable(),
  recordedAt: Timestamp,
  /** When the record will be discarded. */
  expiresAt: Timestamp,
});
/** A stored evaluation's cost record. */
export type ReceiptRecord = z.infer<typeof ReceiptRecord>;

/** The labels of the request an evaluation record keeps: never content, never learner data. */
export const EvaluationRecordContext = EvaluationContext.pick({
  audience: true,
  gradeBand: true,
  subject: true,
  activityKind: true,
  graded: true,
  costCenterId: true,
  parentRequestId: true,
});
/** The labels of the request an evaluation record keeps. */
export type EvaluationRecordContext = z.infer<typeof EvaluationRecordContext>;

/**
 * One retained evaluation, as returned by `GET /v1/evaluations/{evaluationId}` and listed by
 * `GET /v1/evaluations` (0.5.0). It is content-free: the request's identifiers and labels, the
 * full {@link EvaluationResult} (decision, reason codes, findings with spans only, receipt and
 * route) and when it was recorded. A record is visible only to its own tenant and is discarded at
 * `expiresAt`. Replays of an idempotent request do not create another record.
 */
export const EvaluationRecord = z.object({
  schemaVersion: SchemaVersion,
  evaluationId: OpaqueId,
  requestId: OpaqueId,
  tenantId: OpaqueId,
  product: Product,
  surface: MachineCode,
  evaluationKind: EvaluationKind,
  contentType: ContentType,
  policy: PolicyRef,
  context: EvaluationRecordContext,
  /** The tenant's enforcement mode when it was evaluated; `shadow` results enforce `allow`. */
  mode: EnforcementMode,
  result: EvaluationResult,
  recordedAt: Timestamp,
  /** When the record will be discarded. */
  expiresAt: Timestamp,
});
/** One retained evaluation. */
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;

/** The most records one page returns. */
export const MAX_EVALUATION_PAGE_SIZE = 200;
/** Records per page when `limit` is not given. */
export const DEFAULT_EVALUATION_PAGE_SIZE = 50;

/** An opaque continuation token from a previous page. */
export const EvaluationCursor = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

/**
 * Filters for `GET /v1/evaluations`, sent as query parameters. Every filter is optional and they
 * combine with AND; `from` is inclusive and `to` exclusive, both on `recordedAt`.
 */
export const EvaluationQuery = z.object({
  limit: z.int().min(1).max(MAX_EVALUATION_PAGE_SIZE).optional(),
  cursor: EvaluationCursor.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  decision: Decision.optional(),
  evaluationKind: EvaluationKind.optional(),
  profileId: OpaqueId.optional(),
  surface: MachineCode.optional(),
  requestId: OpaqueId.optional(),
  /** Records whose result carries this reason code (top-level or on a finding). */
  reasonCode: MachineCode.optional(),
  /** Records where any route call used this model. */
  modelId: z.string().min(1).max(128).optional(),
  mode: EnforcementMode.optional(),
  /** Records where some family did (or did not) escalate. */
  escalated: z.boolean().optional(),
});
/** Filters for `GET /v1/evaluations`. */
export type EvaluationQuery = z.infer<typeof EvaluationQuery>;

const QUERY_KEYS = Object.keys(EvaluationQuery.shape) as (keyof EvaluationQuery)[];

/** Encodes a query as URL search parameters, in a stable order. */
export function evaluationQueryParams(query: EvaluationQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = query[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

/**
 * Parses URL search parameters into a query, or returns the names of the invalid or unknown
 * parameters (never their values, which a caller could fill with anything).
 */
export function parseEvaluationQuery(params: URLSearchParams): { ok: true; query: EvaluationQuery } | { ok: false; fields: string[] } {
  const raw: Record<string, unknown> = {};
  const bad = new Set<string>();
  for (const [key, value] of params) {
    if (!(QUERY_KEYS as string[]).includes(key) || key in raw) {
      bad.add((QUERY_KEYS as string[]).includes(key) ? key : "(unknown)");
      continue;
    }
    if (key === "limit") raw[key] = /^\d{1,4}$/.test(value) ? Number(value) : value;
    else if (key === "escalated") raw[key] = value === "true" ? true : value === "false" ? false : value;
    else raw[key] = value;
  }
  const parsed = EvaluationQuery.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) bad.add(String(issue.path[0] ?? "(root)"));
  return bad.size === 0 && parsed.success ? { ok: true, query: parsed.data } : { ok: false, fields: [...bad].sort() };
}

/** One page of `GET /v1/evaluations`, newest first. `nextCursor` is null on the last page. */
export const EvaluationPage = z.object({
  schemaVersion: SchemaVersion,
  items: z.array(EvaluationRecord).max(MAX_EVALUATION_PAGE_SIZE),
  nextCursor: EvaluationCursor.nullable(),
});
/** One page of `GET /v1/evaluations`. */
export type EvaluationPage = z.infer<typeof EvaluationPage>;
