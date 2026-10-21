import { z } from "zod";
import { Finding } from "./finding.ts";
import { Decision, EvaluationKind, MachineCode, OpaqueId } from "./primitives.ts";
import { CostReceipt } from "./usage.ts";
import { SchemaVersion } from "./version.ts";

/** Why a result was decided with less than the full evaluator set. */
export const DegradedReason = z.enum(["classifier_timeout", "classifier_unavailable", "budget_exhausted"]);
/** Why a result was decided with less than the full evaluator set. */
export type DegradedReason = z.infer<typeof DegradedReason>;

/** The decision for one evaluation, with the evidence and revisions that produced it. */
export const EvaluationResult = z.object({
  schemaVersion: SchemaVersion,
  evaluationId: OpaqueId,
  requestId: OpaqueId,
  decision: Decision,
  reasonCodes: z.array(MachineCode).max(64),
  findings: z.array(Finding).max(256),
  /** True when a classifier could not give a confident answer. */
  uncertain: z.boolean(),
  policyRevision: OpaqueId,
  evaluatorBundleRevision: OpaqueId,
  /** The decision precedence table that turned findings into `decision`. */
  resolverVersion: OpaqueId,
  /** Null when the evaluation made no billable provider attempt. */
  receipt: CostReceipt.nullable(),
  degraded: z.object({ reason: DegradedReason }).optional(),
});
/** The decision for one evaluation. */
export type EvaluationResult = z.infer<typeof EvaluationResult>;

/** Machine-readable error codes. */
export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "unsupported_schema",
  "policy_not_found",
  "rate_limited",
  "unavailable",
  "idempotency_conflict",
]);
/** Machine-readable error codes. */
export type ErrorCode = z.infer<typeof ErrorCode>;

/** An error response. `message` describes the failure and never quotes request content. */
export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string().max(500),
  retryable: z.boolean(),
});
/** An error response. */
export type ErrorBody = z.infer<typeof ErrorBody>;

/** What a deployment supports; carries no secrets or tenant data. */
export const Capabilities = z.object({
  schemaVersion: SchemaVersion,
  supportedSchemaVersions: z.array(SchemaVersion).min(1),
  evaluationKinds: z.array(EvaluationKind).min(1),
  evaluatorBundles: z.array(z.object({ id: OpaqueId, revision: OpaqueId })),
  policyProfiles: z.array(z.object({ id: OpaqueId, revision: OpaqueId })),
  resolverVersion: OpaqueId,
  classifier: z.object({
    enabled: z.boolean(),
    models: z.array(z.string().min(1).max(128)),
  }),
});
/** What a deployment supports. */
export type Capabilities = z.infer<typeof Capabilities>;

