import { z } from "zod";
import { Finding } from "./finding.ts";
import { Decision, EvaluationKind, MachineCode, OpaqueId } from "./primitives.ts";
import { ContentType } from "./request.ts";
import { CostReceipt } from "./usage.ts";
import { SchemaVersion } from "./version.ts";

/** Why a result was decided with less than the full evaluator set. */
export const DegradedReason = z.enum(["classifier_timeout", "classifier_unavailable", "budget_exhausted"]);
/** Why a result was decided with less than the full evaluator set. */
export type DegradedReason = z.infer<typeof DegradedReason>;

/**
 * How a tenant's decisions are applied: `enforce` returns the resolved decision; `shadow` returns
 * `allow` and records the would-be decision in {@link EvaluationResult.shape.shadow}. The mode is
 * service configuration per tenant, never something a caller can ask for.
 */
export const EnforcementMode = z.enum(["enforce", "shadow"]);
/** How a tenant's decisions are applied. */
export type EnforcementMode = z.infer<typeof EnforcementMode>;

/**
 * The decision an evaluation would have enforced, recorded on a shadow-mode result. Added in 1.0
 * as an optional field: a client that does not know it simply sees the `allow` it must enforce.
 */
export const ShadowOutcome = z.object({
  decision: Decision,
  reasonCodes: z.array(MachineCode).max(64),
});
/** The decision an evaluation would have enforced. */
export type ShadowOutcome = z.infer<typeof ShadowOutcome>;

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
  /**
   * Present only when the result was produced in shadow mode: `decision` is then `allow` (the
   * caller enforces it as usual) and this records what enforcement would have returned. Findings,
   * `uncertain` and `degraded` describe the real evaluation either way.
   */
  shadow: ShadowOutcome.optional(),
}).refine((result) => result.shadow === undefined || result.decision === "allow", {
  message: "a shadow-mode result enforces allow",
  path: ["decision"],
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
  /**
   * Content types the deployment accepts. Added in 1.0 as an optional field: a deployment that
   * omits it accepts `text` and `digest` only. Whether images are classified depends on the
   * pinned profile.
   */
  contentTypes: z.array(ContentType).min(1).optional(),
});
/** What a deployment supports. */
export type Capabilities = z.infer<typeof Capabilities>;

