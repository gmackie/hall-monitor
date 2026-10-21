import { z } from "zod";
import { MachineCode, OpaqueId } from "./primitives.ts";
import { MAX_TEXT_LENGTH } from "./request.ts";

/** The risk family a finding belongs to. */
export const FindingCategory = z.enum([
  "safety",
  "self-harm",
  "harassment",
  "sexual",
  "violence",
  "hate",
  "privacy",
  "prompt-injection",
  "academic-integrity",
  "age-fit",
  "quality",
  "rights",
  "format",
]);
/** The risk family a finding belongs to. */
export type FindingCategory = z.infer<typeof FindingCategory>;

/**
 * How strongly a finding pushes the decision. Severity is evidence for the resolver, not the
 * decision itself: policy turns severities into an action.
 */
export const Severity = z.enum(["info", "warn", "hold", "block", "support"]);
/** How strongly a finding pushes the decision. */
export type Severity = z.infer<typeof Severity>;

/** A half-open `[start, end)` range of UTF-16 offsets into the evaluated text. */
export const Span = z
  .object({
    start: z.int().min(0).max(MAX_TEXT_LENGTH),
    end: z.int().min(0).max(MAX_TEXT_LENGTH),
  })
  .refine((span) => span.start <= span.end, { message: "span start must not exceed end" });
/** A half-open range of offsets into the evaluated text. */
export type Span = z.infer<typeof Span>;

/**
 * One evaluator's observation. It carries a reason code and an optional span, never the text it
 * matched, so findings are safe to log and store.
 */
export const Finding = z.object({
  evaluatorId: OpaqueId,
  evaluatorVersion: OpaqueId,
  category: FindingCategory,
  reasonCode: MachineCode,
  severity: Severity,
  confidence: z.number().min(0).max(1).optional(),
  span: Span.optional(),
});
/** One evaluator's observation. */
export type Finding = z.infer<typeof Finding>;
