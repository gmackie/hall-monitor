import { EvaluationKind, FindingCategory, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

const Version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(32);
const Text = z.string().min(1).max(2048).refine((s) => s.trim().length > 0);
export const DecisionModality = z.enum(["text", "image"]);
export type DecisionModality = z.infer<typeof DecisionModality>;

/** Descriptive ownership is not a calibration, institutional or privacy approval. */
const Provenance = z.strictObject({
  ownerRole: OpaqueId,
  ownerAssignment: z.enum(["pending", "assigned"]),
  ownerRef: OpaqueId.nullable(),
  reference: Text,
}).refine((p) => (p.ownerAssignment === "pending") === (p.ownerRef === null));

export const DecisionDefinition = z.strictObject({
  id: OpaqueId,
  version: Version,
  category: FindingCategory,
  positiveCriteria: z.array(Text).min(1).max(16),
  negativeCriteria: z.array(Text).min(1).max(16),
  requiredContext: z.array(z.enum(["audience", "evaluationKind", "gradeBand"])).min(1).max(3),
  evaluationKinds: z.array(EvaluationKind).min(1).max(4),
  questions: z.array(z.strictObject({ modality: DecisionModality, instructions: Text })).min(1).max(2),
  providerIds: z.array(OpaqueId).min(1).max(8),
  fixtureRevision: OpaqueId,
  provenance: Provenance,
});

const Pack = z.strictObject({
  schemaVersion: z.literal("1.0"),
  manifest: z.strictObject({
    id: OpaqueId,
    version: Version,
    adapter: z.literal("clef-1"),
    classifierVersion: Version,
    calibration: z.literal("unvalidated"),
    fixtureRevision: OpaqueId,
    modalities: z.array(DecisionModality).min(1).max(2),
    providers: z.array(z.strictObject({ id: OpaqueId, modelIds: z.array(z.string().min(1).max(128)).min(1).max(8) })).min(1).max(8),
    decisions: z.array(z.strictObject({ id: OpaqueId, version: Version })).min(1).max(64),
    provenance: Provenance,
  }),
  definitions: z.array(DecisionDefinition).min(1).max(64),
});

export const DecisionPackPin = z.strictObject({ id: OpaqueId, version: Version, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
export type DecisionPackPin = Readonly<z.infer<typeof DecisionPackPin>>;

type Immutable<T> = T extends readonly (infer U)[] ? readonly Immutable<U>[] : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type DecisionPack = Immutable<z.infer<typeof Pack>>;

function unique(values: readonly string[]): boolean {
  return values.length === new Set(values).size;
}

/** Strict parsing plus cross-reference checks; the caller never retains a mutable alias. */
export function parseDecisionPack(value: unknown): DecisionPack | undefined {
  const result = Pack.safeParse(value);
  if (!result.success) return undefined;
  const { manifest, definitions } = result.data;
  if (!unique(manifest.decisions.map((d) => d.id)) || !unique(definitions.map((d) => d.id)) ||
      !unique(manifest.modalities) || !unique(manifest.providers.map((p) => p.id)) ||
      manifest.providers.some((p) => !unique(p.modelIds)) || manifest.decisions.length !== definitions.length) return undefined;
  // Manifest order is the wire-question order and is part of the digest.
  for (const [index, definition] of definitions.entries()) {
    const reference = manifest.decisions[index];
    if (reference?.id !== definition.id || reference.version !== definition.version ||
        definition.fixtureRevision !== manifest.fixtureRevision || !unique(definition.requiredContext) ||
        !unique(definition.evaluationKinds) || !unique(definition.providerIds) ||
        !unique(definition.questions.map((q) => q.modality)) ||
        definition.questions.length !== manifest.modalities.length ||
        manifest.modalities.some((m) => !definition.questions.some((q) => q.modality === m)) ||
        definition.providerIds.length !== manifest.providers.length ||
        manifest.providers.some((p) => !definition.providerIds.includes(p.id))) return undefined;
  }
  return freeze(result.data);
}

/** Only used on newly parsed plain JSON, not on caller-owned values. */
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
