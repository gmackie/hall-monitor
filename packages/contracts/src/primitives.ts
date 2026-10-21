import { z } from "zod";

/**
 * An opaque identifier (request, tenant, receipt, cost center, ...). The restricted alphabet keeps
 * free text, and therefore content, out of identifier fields.
 */
export const OpaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** An opaque identifier (request, tenant, receipt, cost center, ...). */
export type OpaqueId = z.infer<typeof OpaqueId>;

/**
 * A non-negative amount of integer nanodollars (10⁻⁹ USD) as a canonical decimal string: no sign,
 * no leading zeros, at most 30 digits, so equal amounts are always the same string. Parse it to
 * `bigint` for arithmetic; it is never a float. Usage and cost amounts use this form.
 */
export const UsdNano = z.string().regex(/^(0|[1-9]\d{0,29})$/);
/** A non-negative amount of integer nanodollars as a canonical decimal string. */
export type UsdNano = z.infer<typeof UsdNano>;

/**
 * A signed amount of integer nanodollars as a canonical decimal string (no leading zeros, no
 * `-0`, at most 30 digits), for adjustments and credits.
 */
export const SignedUsdNano = z.string().regex(/^(0|-?[1-9]\d{0,29})$/);
/** A signed amount of integer nanodollars as a canonical decimal string. */
export type SignedUsdNano = z.infer<typeof SignedUsdNano>;

/** A lowercase dotted machine code, e.g. `privacy.email` or `moderation.input`. */
export const MachineCode = z
  .string()
  .max(96)
  .regex(/^[a-z][a-z0-9_.]*$/);
/** A lowercase dotted machine code. */
export type MachineCode = z.infer<typeof MachineCode>;

/** The product asking for an evaluation or owning a cost. */
export const Product = z.enum(["schoolos", "playtrek", "hall-monitor", "other"]);
/** The product asking for an evaluation or owning a cost. */
export type Product = z.infer<typeof Product>;

/** What is being evaluated: user input, model output, candidate content or an evaluator result. */
export const EvaluationKind = z.enum([
  "interaction.input",
  "interaction.output",
  "content.candidate",
  "assessment.evaluator-result",
]);
/** What is being evaluated. */
export type EvaluationKind = z.infer<typeof EvaluationKind>;

/**
 * The action the calling product must enforce. `support` routes to supportive safety UX and is
 * never a punitive rejection.
 */
export const Decision = z.enum(["allow", "coach", "hold", "block", "support"]);
/** The action the calling product must enforce. */
export type Decision = z.infer<typeof Decision>;

/** A verified grade band; exact ages and birth dates never cross the wire. */
export const GradeBand = z.enum(["K-2", "3-5", "6-8", "9-12", "adult"]);
/** A verified grade band. */
export type GradeBand = z.infer<typeof GradeBand>;

/** Who will read the evaluated content. */
export const Audience = z.enum(["student", "educator", "public"]);
/** Who will read the evaluated content. */
export type Audience = z.infer<typeof Audience>;

/** An ISO-8601 UTC timestamp with an offset. */
export const Timestamp = z.iso.datetime({ offset: true });
/** An ISO-8601 UTC timestamp with an offset. */
export type Timestamp = z.infer<typeof Timestamp>;
