import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import type { Env } from "./env.ts";
import { forbidden } from "./http.ts";

/**
 * Admin roles. `admin` is global (stored with tenant `*`) and holds every role on every tenant.
 * The others are granted per tenant, and each of them also lets the holder view that tenant.
 */
export const Role = z.enum(["viewer", "policy-editor", "labeler", "adjudicator", "publisher", "admin"]);
export type Role = z.infer<typeof Role>;

/** The tenant a global grant is stored under. */
export const GLOBAL_TENANT = "*";
/** Tenants the global admin can view when `HM_ADMIN_TENANTS` is unset. */
export const DEFAULT_ADMIN_TENANTS = ["playtrek", "playtrek-beta"] as const;

export interface Grant {
  readonly tenant: string;
  readonly role: Role;
}

/** The signed-in person and everything they hold. */
export interface Principal {
  readonly email: string;
  readonly grants: readonly Grant[];
  readonly isAdmin: boolean;
}

/** Emails that always hold `admin`, from `HM_ADMIN_BOOTSTRAP_EMAILS` (comma-separated or a JSON array). */
export function bootstrapAdmins(env: Pick<Env, "HM_ADMIN_BOOTSTRAP_EMAILS">): Set<string> {
  const raw = env.HM_ADMIN_BOOTSTRAP_EMAILS?.trim() ?? "";
  if (raw === "") return new Set();
  let list: unknown = raw.split(",");
  if (raw.startsWith("[")) {
    try {
      list = JSON.parse(raw);
    } catch {
      return new Set();
    }
  }
  return new Set((Array.isArray(list) ? list : []).filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()).filter((v) => v !== ""));
}

/** Loads the principal's grants from D1, plus the bootstrap admin grant. */
export async function loadPrincipal(env: Env, email: string): Promise<Principal> {
  const { results } = await env.DB.prepare("SELECT tenant, role FROM roles WHERE email = ?1").bind(email).all<{ tenant: string; role: string }>();
  const grants: Grant[] = results.flatMap((row) => {
    const role = Role.safeParse(row.role);
    return role.success ? [{ tenant: row.tenant, role: role.data }] : [];
  });
  const isAdmin = bootstrapAdmins(env).has(email) || grants.some((grant) => grant.role === "admin" && grant.tenant === GLOBAL_TENANT);
  return { email, grants, isAdmin };
}

/** Whether the principal holds `role` on `tenant`. `viewer` is satisfied by any role on the tenant. */
export function hasRole(principal: Principal, tenant: string, role: Role): boolean {
  if (principal.isAdmin) return true;
  if (role === "admin") return false;
  return principal.grants.some((grant) => grant.tenant === tenant && (grant.role === role || role === "viewer"));
}

/** Whether the principal holds `role` on any tenant (global routes such as releases). */
export function hasRoleAnywhere(principal: Principal, role: Role): boolean {
  return principal.isAdmin || principal.grants.some((grant) => grant.role === role && grant.tenant !== GLOBAL_TENANT);
}

export function requireRole(principal: Principal, tenant: string, role: Role): void {
  if (!hasRole(principal, tenant, role)) throw forbidden();
}

export function requireAdmin(principal: Principal): void {
  if (!principal.isAdmin) throw forbidden();
}

/** `HM_ADMIN_TENANTS`, or the default when unset or invalid. */
export function adminTenants(env: Pick<Env, "HM_ADMIN_TENANTS">): string[] {
  const raw = env.HM_ADMIN_TENANTS?.trim() ?? "";
  if (raw === "") return [...DEFAULT_ADMIN_TENANTS];
  try {
    const parsed = z.array(OpaqueId).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [...DEFAULT_ADMIN_TENANTS];
  } catch {
    return [...DEFAULT_ADMIN_TENANTS];
  }
}

/**
 * The tenants the principal can view, in a stable order. The global admin sees `HM_ADMIN_TENANTS`
 * plus every tenant named in any role grant; anyone else sees the tenants they hold a role on.
 */
export async function viewableTenants(env: Env, principal: Principal): Promise<string[]> {
  if (!principal.isAdmin) return [...new Set(principal.grants.map((grant) => grant.tenant).filter((tenant) => tenant !== GLOBAL_TENANT))].sort();
  const { results } = await env.DB.prepare("SELECT DISTINCT tenant FROM roles WHERE tenant <> ?1").bind(GLOBAL_TENANT).all<{ tenant: string }>();
  const configured = adminTenants(env);
  return [...configured, ...results.map((row) => row.tenant).filter((tenant) => !configured.includes(tenant)).sort()];
}
