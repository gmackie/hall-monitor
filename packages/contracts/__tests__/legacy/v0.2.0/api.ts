import { z } from "zod";
import { EvaluationKind, OpaqueId, Timestamp } from "./primitives.ts";
import { EvaluationRequest } from "./request.ts";
import { ErrorBody, EvaluationResult } from "./result.ts";
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
