import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import { auditStatement } from "../audit.ts";
import { invalid, json, readJson } from "../http.ts";
import { GLOBAL_TENANT, Role, requireAdmin } from "../roles.ts";
import { route } from "../router.ts";

const Email = z.string().trim().toLowerCase().regex(/^[^\s@]{1,64}@[^\s@]{1,253}$/);
const Grant = z.strictObject({ email: Email, tenant: z.union([OpaqueId, z.literal(GLOBAL_TENANT)]), role: Role })
  .refine((grant) => (grant.role === "admin") === (grant.tenant === GLOBAL_TENANT), { message: "admin is global; other roles are per tenant" });

function parseGrant(body: unknown) {
  const parsed = Grant.safeParse(body);
  if (!parsed.success) throw invalid("a grant is {email, tenant, role}; admin is granted on tenant '*', other roles per tenant");
  return parsed.data;
}

export const adminRoutes = [
  route("GET", "/roles", async ({ env, principal }) => {
    requireAdmin(principal);
    const { results } = await env.DB.prepare("SELECT email, tenant, role, granted_by AS grantedBy, granted_at AS grantedAt FROM roles ORDER BY email, tenant, role").all();
    return json({ roles: results });
  }),
  route("POST", "/roles", async ({ env, principal, request }) => {
    requireAdmin(principal);
    const grant = parseGrant(await readJson(request));
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO roles (email, tenant, role, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(grant.email, grant.tenant, grant.role, principal.email, new Date().toISOString()),
      auditStatement(env, principal.email, "role.granted", grant.tenant, "role", `${grant.role}:${grant.email}`),
    ]);
    return json({ granted: grant }, 201);
  }),
  route("POST", "/roles:revoke", async ({ env, principal, request }) => {
    requireAdmin(principal);
    const grant = parseGrant(await readJson(request));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM roles WHERE email = ?1 AND tenant = ?2 AND role = ?3").bind(grant.email, grant.tenant, grant.role),
      auditStatement(env, principal.email, "role.revoked", grant.tenant, "role", `${grant.role}:${grant.email}`),
    ]);
    return json({ revoked: grant });
  }),
  /** The audit log, newest first; `?tenant=` narrows it. Rows name actors, actions and ids only. */
  route("GET", "/audit", async ({ env, principal, url }) => {
    requireAdmin(principal);
    const tenant = url.searchParams.get("tenant");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "100") || 100, 1), 500);
    const statement = tenant === null
      ? env.DB.prepare("SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?1").bind(limit)
      : env.DB.prepare("SELECT * FROM audit_log WHERE tenant = ?1 ORDER BY at DESC, id DESC LIMIT ?2").bind(tenant, limit);
    const { results } = await statement.all();
    return json({ entries: results });
  }),
];
