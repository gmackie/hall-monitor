import { z } from "zod";
import { Audience, EvaluationKind, GradeBand, MachineCode, OpaqueId, Product } from "./primitives.ts";
import { SchemaVersion } from "./version.ts";

/** The longest text, in UTF-16 code units, a single evaluation accepts. */
export const MAX_TEXT_LENGTH = 32_000;

/** Text content, evaluated in memory and never echoed into results, receipts or errors. */
export const TextContent = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  /**
   * Expected answers that must not appear in student-facing content, for answer-leakage checks on
   * candidate content and model output. Added in 1.0 as an optional field; never echoed back.
   */
  answerKey: z.array(z.string().min(1).max(500)).max(100).optional(),
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

/** Image media types image content may carry: exactly the ones Clef accepts. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** An image media type image content may carry. */
export const ImageMediaType = z.enum(IMAGE_MEDIA_TYPES);
/** An image media type image content may carry. */
export type ImageMediaType = z.infer<typeof ImageMediaType>;

/** The most images one evaluation carries (Clef's limit). */
export const MAX_IMAGES = 4;
/** The largest decoded image, in bytes (Clef's per-image limit, 4 MiB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** The largest decoded total across one evaluation's images, in bytes (Clef's limit, 8 MiB). */
export const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
/** The longest base64 string that can decode to {@link MAX_IMAGE_BYTES}. */
export const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** Standard base64 (RFC 4648 §4) with padding; checked for length by {@link base64DecodedLength}. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The number of bytes a padded base64 string decodes to, or null when it is not well-formed
 * padded base64. Computed from the length, without decoding.
 */
export function base64DecodedLength(base64: string): number | null {
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Whether the first decoded bytes are the signature of `mediaType`, so a mislabelled file is refused. */
function hasSignature(base64: string, mediaType: ImageMediaType): boolean {
  let head: string;
  try {
    head = atob(base64.slice(0, 16));
  } catch {
    return false;
  }
  switch (mediaType) {
    case "image/png":
      return head.startsWith("\x89PNG\r\n\x1a\n");
    case "image/jpeg":
      return head.startsWith("\xff\xd8\xff");
    case "image/webp":
      return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
  }
}

/**
 * One embedded image: base64 bytes of a PNG, JPEG or WebP file whose signature matches
 * `mimeType`, at most {@link MAX_IMAGE_BYTES} decoded. Evaluated in memory and never logged,
 * stored or echoed. Remote URLs are not accepted.
 */
export const EmbeddedImage = z
  .object({
    mimeType: ImageMediaType,
    base64: z.string().min(4).max(MAX_IMAGE_BASE64_LENGTH).regex(BASE64),
  })
  .refine((image) => {
    const bytes = base64DecodedLength(image.base64);
    return bytes !== null && bytes > 0 && bytes <= MAX_IMAGE_BYTES && hasSignature(image.base64, image.mimeType);
  }, { message: "must be padded base64 of a PNG, JPEG or WebP image matching mimeType, at most 4 MiB decoded", path: ["base64"] });
/** One embedded image. */
export type EmbeddedImage = z.infer<typeof EmbeddedImage>;

/**
 * Image content: one to {@link MAX_IMAGES} embedded images, at most {@link MAX_TOTAL_IMAGE_BYTES}
 * decoded in total, with optional accompanying text (a caption or the message the images came
 * with), which is evaluated together with them. Added in 1.0 as a new content variant: documents
 * using the other variants are unchanged. Never echoed into results, receipts, errors or logs.
 */
export const ImageContent = z
  .object({
    type: z.literal("image"),
    images: z.array(EmbeddedImage).min(1).max(MAX_IMAGES),
    text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  })
  .refine((content) => content.images.reduce((total, image) => total + (base64DecodedLength(image.base64) ?? 0), 0) <= MAX_TOTAL_IMAGE_BYTES, {
    message: "images must total at most 8 MiB decoded",
    path: ["images"],
  });
/** Image content with optional accompanying text. */
export type ImageContent = z.infer<typeof ImageContent>;

/** The kinds of content an evaluation can carry, as advertised in capabilities. */
export const ContentType = z.enum(["text", "digest", "image"]);
/** A kind of content an evaluation can carry. */
export type ContentType = z.infer<typeof ContentType>;

/** The content under evaluation. */
export const EvaluationContent = z.discriminatedUnion("type", [TextContent, DigestContent, ImageContent]);
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
