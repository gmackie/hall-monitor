import { BUILTIN_PROFILE_REVISION, BUILTIN_PROFILES } from "@gmacko/hall-monitor-policy";
import { json } from "../http.ts";
import { assessOverlay, floorParam, publishedRevisions, revisionOf, type RevisionRow, tenantOf } from "../revisions.ts";
import { requireRole } from "../roles.ts";
import { route, SEG } from "../router.ts";

export const profileReadRoutes = [
  /** Every built-in floor, the tenant's latest published overlay on it and the effective profile. */
  route("GET", `/tenants/${SEG}/profiles`, async (ctx) => {
    const tenant = tenantOf(ctx);
    requireRole(ctx.principal, tenant, "viewer");
    const published = await publishedRevisions(ctx.env, tenant);
    const profiles = Object.keys(BUILTIN_PROFILES).sort().map((id) => {
      const floor = BUILTIN_PROFILES[id]!;
      const row = published.get(id);
      const revision = row === undefined ? null : revisionOf(row);
      const effective = revision === null ? floor : assessOverlay(floor, revision.overlay).profile;
      return { id, floorRevision: BUILTIN_PROFILE_REVISION, floor, published: revision, effective };
    });
    return json({ tenant, profiles });
  }),
  route("GET", `/tenants/${SEG}/profiles/${SEG}/revisions`, async (ctx) => {
    const tenant = tenantOf(ctx);
    requireRole(ctx.principal, tenant, "viewer");
    const floor = floorParam(ctx.params[1]!);
    const { results } = await ctx.env.DB.prepare("SELECT * FROM profile_revisions WHERE tenant = ?1 AND profile_id = ?2 ORDER BY created_at DESC, id DESC")
      .bind(tenant, floor.id).all<RevisionRow>();
    return json({ tenant, profileId: floor.id, revisions: results.map(revisionOf) });
  }),
];
