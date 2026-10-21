import { z } from "zod";
import { Audience, EvaluationKind, GradeBand, MachineCode, OpaqueId, Product } from "./primitives.ts";
import { SchemaVersion } from "./version.ts";

/** The longest text, in UTF-16 code units, a single evaluation accepts. */
export const MAX_TEXT_LENGTH = 32_000;

/** Text content, evaluated in memory and never echoed into results, receipts or errors. */
export const TextContent = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});
/** Text content, evaluated in memory and never echoed back. */
export type TextContent = z.infer<typeof TextContent>;

/**
 * Content known only by its SHA-256 digest and media type, for callers that may not disclose the
 * bytes. Only metadata checks can run on it.
 */
export const DigestContent = z.object({
  type: z.literal("digest"),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
});
/** Content known only by its SHA-256 digest and media type. */
export type DigestContent = z.infer<typeof DigestContent>;

/** The content under evaluation. */
export const EvaluationContent = z.discriminatedUnion("type", [TextContent, DigestContent]);
/** The content under evaluation. */
export type EvaluationContent = z.infer<typeof EvaluationContent>;

/** The calling product and its tenant. The tenant comes from the caller's verified identity. */
export const EvaluationSource = z.object({
  product: Product,
  tenantId: OpaqueId,
  /** Where in the product the content arose, e.g. `student.chat`. */
  surface: MachineCode,
});
/** The calling product and its tenant. */
export type EvaluationSource = z.infer<typeof EvaluationSource>;

/** The pinned policy profile revision to evaluate under. */
export const PolicyRef = z.object({
  profileId: OpaqueId,
  revision: OpaqueId,
});
/** The pinned policy profile revision to evaluate under. */
export type PolicyRef = z.infer<typeof PolicyRef>;

/** Curriculum and billing context. Every field is a label, never learner data. */
export const EvaluationContext = z.object({
  gradeBand: GradeBand.optional(),
  subject: MachineCode.optional(),
  activityKind: MachineCode.optional(),
  audience: Audience,
  /** Whether the work counts toward a grade, which changes how direct-answer help is treated. */
  graded: z.boolean().optional(),
  costCenterId: OpaqueId,
  parentRequestId: OpaqueId.optional(),
});
/** Curriculum and billing context. */
export type EvaluationContext = z.infer<typeof EvaluationContext>;

/** The shape of the surrounding conversation: counts only, never prior message text. */
export const ConversationSummary = z.object({
  priorMessageCount: z.int().min(0).max(100_000),
});
/** The shape of the surrounding conversation. */
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/** A request to evaluate one piece of content under one policy revision. */
export const EvaluationRequest = z.object({
  schemaVersion: SchemaVersion,
  requestId: OpaqueId,
  idempotencyKey: OpaqueId,
  source: EvaluationSource,
  policy: PolicyRef,
  context: EvaluationContext,
  evaluationKind: EvaluationKind,
  content: EvaluationContent,
  conversation: ConversationSummary.optional(),
});
/** A request to evaluate one piece of content under one policy revision. */
export type EvaluationRequest = z.infer<typeof EvaluationRequest>;
