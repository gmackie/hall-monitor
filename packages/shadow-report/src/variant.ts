import type { DecisionResolver } from "@gmacko/hall-monitor-core";
import { applyOverlay, BUILTIN_PROFILES, PolicyOverlay, type PolicyProfile, RESOLVER_VERSION } from "@gmacko/hall-monitor-policy";
import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/**
 * One policy configuration to evaluate a corpus under: a revision of each profile and, optionally,
 * another resolver version. Two variants over the same frozen corpus make a decision diff.
 */
export interface PolicyVariant {
  readonly label: string;
  /** Effective profiles by id; each case is pinned to its profile's revision here. */
  readonly profiles: Readonly<Record<string, PolicyProfile>>;
  /** Defaults to the current resolver. */
  readonly resolve?: DecisionResolver;
  /** The resolver version `resolve` reports; for the report header. */
  readonly resolverVersion: string;
  /** Overlay fields that would have weakened a floor and were clamped to it (paths only). */
  readonly clampedFields: readonly string[];
}

/** A variant file: overlays by profile id, in the shape of one tenant's `HM_POLICY_OVERLAYS` entry. */
export const VariantOverlays = z.record(OpaqueId, PolicyOverlay);
/** A variant file: overlays by profile id. */
export type VariantOverlays = z.infer<typeof VariantOverlays>;

/** The built-in profiles at their published revision, resolved by the current resolver. */
export const BUILTIN_VARIANT: PolicyVariant = Object.freeze({
  label: "builtin",
  profiles: BUILTIN_PROFILES,
  resolverVersion: RESOLVER_VERSION,
  clampedFields: [],
});

/**
 * A variant that applies `overlays` to the built-in floors exactly as the Worker does: overlays
 * only tighten, and a weakening field is clamped to the floor and listed in `clampedFields`.
 * Overlays for unknown profile ids are refused.
 */
export function overlayVariant(label: string, overlays: unknown, base: PolicyVariant = BUILTIN_VARIANT): PolicyVariant {
  const parsed = VariantOverlays.parse(overlays);
  const profiles: Record<string, PolicyProfile> = { ...base.profiles };
  const clampedFields: string[] = [];
  for (const [profileId, overlay] of Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))) {
    const floor = BUILTIN_PROFILES[profileId];
    if (floor === undefined) throw new Error(`overlay names an unknown profile: ${profileId}`);
    const { profile, violations } = applyOverlay(floor, { ...overlay, id: floor.id });
    clampedFields.push(...violations.map((violation) => `${profileId}.${violation.field}`));
    profiles[profileId] = profile;
  }
  return { label, profiles, resolverVersion: base.resolverVersion, clampedFields, ...(base.resolve === undefined ? {} : { resolve: base.resolve }) };
}

/** A variant evaluated with another resolver, e.g. a candidate precedence table. */
export function resolverVariant(label: string, resolve: DecisionResolver, resolverVersion: string, base: PolicyVariant = BUILTIN_VARIANT): PolicyVariant {
  return { ...base, label, resolve, resolverVersion };
}
