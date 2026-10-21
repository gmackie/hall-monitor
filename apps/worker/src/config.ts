import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { applyOverlay, BUILTIN_PROFILE_REVISION, BUILTIN_PROFILES, PolicyOverlay, type PolicyProfile } from "@gmacko/hall-monitor-policy";
import { z } from "zod";
import { type TrustedIssuer, TrustedIssuers } from "./auth.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

const Overlays = z.record(OpaqueId, z.record(OpaqueId, PolicyOverlay));
type Overlays = z.infer<typeof Overlays>;

/** Configuration parsed from the environment; `undefined` members failed to parse. */
export interface Config {
  readonly issuers: readonly TrustedIssuer[] | undefined;
  readonly audience: string | undefined;
  /** Effective profiles by tenant, then profile id; undefined when the overlay JSON is invalid. */
  readonly overlays: ReadonlyMap<string, ReadonlyMap<string, PolicyProfile>> | undefined;
}

let cached: { readonly key: string; readonly config: Config } | undefined;

/**
 * Parses and caches the configuration for this isolate. Invalid JSON never throws here: the
 * affected part is left undefined, logged once by variable name, and every path that needs it
 * fails closed.
 */
export function loadConfig(env: Env): Config {
  const key = JSON.stringify([env.HM_TRUSTED_ISSUERS, env.HM_AUDIENCE, env.HM_POLICY_OVERLAYS]);
  if (cached?.key === key) return cached.config;

  const issuers = parseJson(env.HM_TRUSTED_ISSUERS, TrustedIssuers);
  if (issuers === undefined) log("error", "config.invalid", { variable: "HM_TRUSTED_ISSUERS" });
  const audience = env.HM_AUDIENCE === undefined || env.HM_AUDIENCE.length === 0 ? undefined : env.HM_AUDIENCE;
  const overlays = env.HM_POLICY_OVERLAYS === undefined || env.HM_POLICY_OVERLAYS.trim() === "" ? {} : parseJson(env.HM_POLICY_OVERLAYS, Overlays);
  if (overlays === undefined) log("error", "config.invalid", { variable: "HM_POLICY_OVERLAYS" });

  const config: Config = { issuers, audience, overlays: overlays === undefined ? undefined : resolveOverlays(overlays) };
  cached = { key, config };
  return config;
}

/**
 * Applies each tenant's overlays to the built-in floors. Overlays may only tighten; weakening
 * fields are clamped to the floor and counted in the log, never itemized. An overlay for an
 * unknown profile id is ignored.
 */
function resolveOverlays(overlays: Overlays): Map<string, Map<string, PolicyProfile>> {
  const byTenant = new Map<string, Map<string, PolicyProfile>>();
  for (const [tenant, profiles] of Object.entries(overlays)) {
    const effective = new Map<string, PolicyProfile>();
    for (const [profileId, overlay] of Object.entries(profiles)) {
      const floor = BUILTIN_PROFILES[profileId];
      if (floor === undefined) continue;
      const { profile, violations } = applyOverlay(floor, { ...overlay, id: floor.id });
      if (violations.length > 0) log("warn", "policy.overlay_clamped", { tenant, profileId, violations: violations.length });
      effective.set(profileId, profile);
    }
    byTenant.set(tenant, effective);
  }
  return byTenant;
}

/**
 * The profile a tenant gets for a pinned `profileId@revision`. A tenant with an overlay for the
 * profile resolves only the overlay's revision, so a caller cannot sidestep its institution's
 * tightening by pinning the built-in floor; other tenants resolve the built-in revision.
 */
export function lookupPolicy(config: Config, tenant: string, profileId: string, revision: string): PolicyProfile | undefined {
  // Unparseable overlays must not silently fall back to the looser floors.
  if (config.overlays === undefined) return undefined;
  const overlaid = config.overlays.get(tenant)?.get(profileId);
  if (overlaid !== undefined) return overlaid.revision === revision ? overlaid : undefined;
  const builtin = Object.hasOwn(BUILTIN_PROFILES, profileId) ? BUILTIN_PROFILES[profileId] : undefined;
  return builtin !== undefined && revision === BUILTIN_PROFILE_REVISION ? builtin : undefined;
}

/** Every profile revision a tenant can pin. */
export function tenantProfiles(config: Config, tenant: string): { id: string; revision: string }[] {
  return Object.keys(BUILTIN_PROFILES)
    .sort()
    .map((id) => ({ id, revision: config.overlays?.get(tenant)?.get(id)?.revision ?? BUILTIN_PROFILE_REVISION }));
}

function parseJson<T>(text: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
