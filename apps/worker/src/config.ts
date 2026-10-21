import { EnforcementMode, OpaqueId } from "@gmacko/hall-monitor-contracts";
import type { EnforcementOptions } from "@gmacko/hall-monitor-core";
import { applyOverlay, BUILTIN_PROFILE_REVISION, BUILTIN_PROFILES, PolicyOverlay, type PolicyProfile } from "@gmacko/hall-monitor-policy";
import { z } from "zod";
import { type TrustedIssuer, TrustedIssuers } from "./auth.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

const Overlays = z.record(OpaqueId, z.record(OpaqueId, PolicyOverlay));
type Overlays = z.infer<typeof Overlays>;

/**
 * One tenant's entry in `HM_TENANT_MODES`: a bare mode, or a mode with explicit permission to
 * shadow student-facing profiles whose input moderation is required (see `shadowEligibility`).
 */
export const TenantModeSetting = z.union([
  EnforcementMode,
  z.strictObject({ mode: EnforcementMode, allowStudentShadow: z.boolean().optional() }),
]);
/** One tenant's entry in `HM_TENANT_MODES`. */
export type TenantModeSetting = z.infer<typeof TenantModeSetting>;

/** `HM_TENANT_MODES`: enforcement mode by tenant. Tenants not listed are enforced. */
export const TenantModes = z.record(OpaqueId, TenantModeSetting);

/** A tenant's resolved enforcement mode. */
export interface TenantMode {
  readonly mode: EnforcementMode;
  readonly allowStudentShadow: boolean;
}

const ENFORCE: TenantMode = Object.freeze({ mode: "enforce", allowStudentShadow: false });

/** Configuration parsed from the environment; `undefined` members failed to parse. */
export interface Config {
  readonly issuers: readonly TrustedIssuer[] | undefined;
  readonly audience: string | undefined;
  /** Effective profiles by tenant, then profile id; undefined when the overlay JSON is invalid. */
  readonly overlays: ReadonlyMap<string, ReadonlyMap<string, PolicyProfile>> | undefined;
  /** Enforcement modes by tenant; undefined when `HM_TENANT_MODES` is invalid, so every tenant is enforced. */
  readonly tenantModes: ReadonlyMap<string, TenantMode> | undefined;
}

let cached: { readonly key: string; readonly config: Config } | undefined;

/**
 * Parses and caches the configuration for this isolate. Invalid JSON never throws here: the
 * affected part is left undefined, logged once by variable name, and every path that needs it
 * fails closed.
 */
export function loadConfig(env: Env): Config {
  const key = JSON.stringify([env.HM_TRUSTED_ISSUERS, env.HM_AUDIENCE, env.HM_POLICY_OVERLAYS, env.HM_TENANT_MODES]);
  if (cached?.key === key) return cached.config;

  const issuers = parseJson(env.HM_TRUSTED_ISSUERS, TrustedIssuers);
  if (issuers === undefined) log("error", "config.invalid", { variable: "HM_TRUSTED_ISSUERS" });
  const audience = env.HM_AUDIENCE === undefined || env.HM_AUDIENCE.length === 0 ? undefined : env.HM_AUDIENCE;
  const overlays = env.HM_POLICY_OVERLAYS === undefined || env.HM_POLICY_OVERLAYS.trim() === "" ? {} : parseJson(env.HM_POLICY_OVERLAYS, Overlays);
  if (overlays === undefined) log("error", "config.invalid", { variable: "HM_POLICY_OVERLAYS" });

  const modes = env.HM_TENANT_MODES === undefined || env.HM_TENANT_MODES.trim() === "" ? {} : parseJson(env.HM_TENANT_MODES, TenantModes);
  if (modes === undefined) log("error", "config.invalid", { variable: "HM_TENANT_MODES" });

  const config: Config = {
    issuers,
    audience,
    overlays: overlays === undefined ? undefined : resolveOverlays(overlays),
    tenantModes: modes === undefined ? undefined : resolveTenantModes(modes),
  };
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

/**
 * A tenant's enforcement mode. It comes only from configuration for the verified tenant, never
 * from the request, and anything unconfigured or unparseable is enforced: misconfiguration can
 * make Hall Monitor stricter, never quieter.
 */
export function tenantMode(config: Config, tenant: string): TenantMode {
  return config.tenantModes?.get(tenant) ?? ENFORCE;
}

/** The core's enforcement options for a tenant, reporting refused shadowing to `onShadowRefused`. */
export function enforcementFor(config: Config, tenant: string, onShadowRefused: (profile: PolicyProfile) => void): EnforcementOptions {
  const { mode, allowStudentShadow } = tenantMode(config, tenant);
  return mode === "enforce" ? { mode } : { mode, allowStudentShadow, onShadowRefused };
}

function resolveTenantModes(modes: z.infer<typeof TenantModes>): Map<string, TenantMode> {
  return new Map(
    Object.entries(modes).map(([tenant, setting]) => [
      tenant,
      typeof setting === "string" ? { mode: setting, allowStudentShadow: false } : { mode: setting.mode, allowStudentShadow: setting.allowStudentShadow === true },
    ]),
  );
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
