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
 * A signed amount of integer nanodollars (10⁻⁹ USD) in decimal string form. Parse it to `bigint`
 * for arithmetic; it is never a float.
 */
export const UsdNano = z.string().max(40).regex(/^-?\d+$/);
/** A signed amount of integer nanodollars in decimal string form. */
export type UsdNano = z.infer<typeof UsdNano>;

/** A non-negative amount of integer nanodollars, used for usage and cost (never credits). */
export const NonNegativeUsdNano = z.string().max(40).regex(/^\d+$/);
/** A non-negative amount of integer nanodollars. */
export type NonNegativeUsdNano = z.infer<typeof NonNegativeUsdNano>;

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
