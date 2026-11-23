import { TenantModeSetting } from "@gmacko/hall-monitor-config-release";
import { PolicyOverlay, ProfileRouting } from "@gmacko/hall-monitor-policy";
import { BUILTIN_CASES, BUILTIN_VARIANT, diffDecisions, overlayVariant, selectCases } from "@gmacko/hall-monitor-shadow-report";
import { z } from "zod";
import { auditStatement, newId } from "../audit.ts";
import { conflict, invalid, json, readJson, segment } from "../http.ts";
import { assessOverlay, floorParam, loadRevision, publishedRevisions, revisionOf, type RevisionRow, tenantOf } from "../revisions.ts";
import { requireAdmin, requireRole } from "../roles.ts";
import { type Ctx, route, SEG } from "../router.ts";
import { mayApprove } from "../two-person.ts";

/** A revision row id in a path: an opaque id without the `:action` suffix. */
const REV = "([A-Za-z0-9][A-Za-z0-9._-]*)";
const BASE = `/tenants/${SEG}/profiles/${SEG}/revisions`;

const Draft = z.strictObject({ overlay: z.unknown(), waiverNoted: z.boolean().optional() });
const RoutingUpdate = z.strictObject({ routing: z.unknown(), waiverNoted: z.boolean().optional() });

function parseOverlay(value: unknown, profileId: string): PolicyOverlay {
  const parsed = PolicyOverlay.safeParse(value);
  if (!parsed.success) throw invalid("overlay must be a PolicyOverlay with a revision");
  if (parsed.data.id !== undefined && parsed.data.id !== profileId) throw invalid("overlay id must be the profile id");
  return { ...parsed.data, id: profileId };
}

function now(): string {
  return new Date().toISOString();
}

/** The revision in the path, after checking the role on its tenant. */
async function pathRevision(ctx: Ctx, role: Parameters<typeof requireRole>[2]) {
  const tenant = tenantOf(ctx);
  requireRole(ctx.principal, tenant, role);
  const floor = floorParam(ctx.params[1]!);
  const row = await loadRevision(ctx.env, tenant, floor.id, segment(ctx.params[2]!));
  return { tenant, floor, row };
}

async function transition(ctx: Ctx, row: RevisionRow, from: RevisionRow["status"], to: RevisionRow["status"], extra: { approver?: string }, action: "revision.proposed" | "revision.approved") {
  const at = now();
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE profile_revisions SET status = ?1, updated_at = ?2${extra.approver === undefined ? "" : ", approver = ?6"} WHERE id = ?3 AND tenant = ?4 AND status = ?5`)
      .bind(to, at, row.id, row.tenant, from, ...(extra.approver === undefined ? [] : [extra.approver])),
    auditStatement(ctx.env, ctx.principal.email, action, row.tenant, "profile_revision", row.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw conflict(`revision is no longer ${from}`);
  return json(revisionOf((await loadRevision(ctx.env, row.tenant, row.profile_id, row.id))));
}

export const profileWriteRoutes = [
  /** Creates a draft revision. Weakening fields are reported (and stored); such a draft cannot be proposed. */
  route("POST", BASE, async (ctx) => {
    const tenant = tenantOf(ctx);
    requireRole(ctx.principal, tenant, "policy-editor");
    const floor = floorParam(ctx.params[1]!);
    const body = Draft.safeParse(await readJson(ctx.request));
    if (!body.success) throw invalid("body is {overlay, waiverNoted?}");
    const overlay = parseOverlay(body.data.overlay, floor.id);
    const assessed = assessOverlay(floor, overlay);
    const id = newId("rev");
    const at = now();
    try {
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(`INSERT INTO profile_revisions (id, tenant, profile_id, revision, overlay_json, status, student_facing, enforces_family, waiver_noted, author, violations_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?11, ?11)`)
          .bind(id, tenant, floor.id, overlay.revision, JSON.stringify(overlay), assessed.studentFacing ? 1 : 0, assessed.enforcesFamily ? 1 : 0,
            body.data.waiverNoted === true ? 1 : 0, ctx.principal.email, JSON.stringify(assessed.violations), at),
        auditStatement(ctx.env, ctx.principal.email, "revision.created", tenant, "profile_revision", id),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) throw conflict("this tenant already has that revision of the profile");
      throw error;
    }
    return json(revisionOf((await loadRevision(ctx.env, tenant, floor.id, id))), 201);
  }),

  /** Replaces a draft's per-family routing, with the same validation. */
  route("PUT", `${BASE}/${REV}/routing`, async (ctx) => {
    const { tenant, floor, row } = await pathRevision(ctx, "policy-editor");
    if (row.status !== "draft") throw conflict("only a draft can change");
    const body = RoutingUpdate.safeParse(await readJson(ctx.request));
    const routing = ProfileRouting.safeParse(body.success ? body.data.routing : undefined);
    if (!body.success || !routing.success) throw invalid("body is {routing, waiverNoted?}");
    const overlay: PolicyOverlay = { ...(JSON.parse(row.overlay_json) as PolicyOverlay), routing: routing.data };
    const assessed = assessOverlay(floor, overlay);
    const waiver = body.data.waiverNoted === undefined ? row.waiver_noted : body.data.waiverNoted ? 1 : 0;
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE profile_revisions SET overlay_json = ?1, student_facing = ?2, enforces_family = ?3, waiver_noted = ?4, violations_json = ?5,
        diff_report_json = NULL, updated_at = ?6 WHERE id = ?7 AND tenant = ?8 AND status = 'draft'`)
        .bind(JSON.stringify(overlay), assessed.studentFacing ? 1 : 0, assessed.enforcesFamily ? 1 : 0, waiver, JSON.stringify(assessed.violations), now(), row.id, tenant),
      auditStatement(ctx.env, ctx.principal.email, "revision.routing_updated", tenant, "profile_revision", row.id),
    ]);
    return json(revisionOf((await loadRevision(ctx.env, tenant, floor.id, row.id))));
  }),

  /**
   * Diffs the decisions the revision would make against the tenant's currently published revision
   * (or the floor) over the synthetic corpus, with the local fake classifier. The report holds
   * case ids, codes and counts only.
   */
  route("POST", `${BASE}/${REV}:diff`, async (ctx) => {
    const { tenant, floor, row } = await pathRevision(ctx, "policy-editor");
    const published = (await publishedRevisions(ctx.env, tenant)).get(floor.id);
    const baseline = published === undefined ? BUILTIN_VARIANT : overlayVariant(`published:${published.revision}`, { [floor.id]: JSON.parse(published.overlay_json) });
    const candidate = overlayVariant(`candidate:${row.revision}`, { [floor.id]: JSON.parse(row.overlay_json) });
    const report = await diffDecisions(selectCases(BUILTIN_CASES, [floor.id]), baseline, candidate, { classifier: { kind: "fake" } });
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE profile_revisions SET diff_report_json = ?1, updated_at = ?2 WHERE id = ?3 AND tenant = ?4").bind(JSON.stringify(report), now(), row.id, tenant),
      auditStatement(ctx.env, ctx.principal.email, "revision.diffed", tenant, "profile_revision", row.id),
    ]);
    return json(report);
  }),

  route("GET", `${BASE}/${REV}/diff`, async (ctx) => {
    const { row } = await pathRevision(ctx, "viewer");
    return json(row.diff_report_json === null ? null : JSON.parse(row.diff_report_json));
  }),

  /** Draft → proposed. A draft with weakening fields cannot be proposed. */
  route("POST", `${BASE}/${REV}:propose`, async (ctx) => {
    const { row } = await pathRevision(ctx, "policy-editor");
    if (row.status !== "draft") throw conflict("only a draft can be proposed");
    if ((JSON.parse(row.violations_json) as unknown[]).length > 0) throw conflict("the draft weakens the floor; remove those fields first");
    return transition(ctx, row, "draft", "proposed", {}, "revision.proposed");
  }),

  /** Proposed → approved, by a publisher who is not the author (two-person rule). */
  route("POST", `${BASE}/${REV}:approve`, async (ctx) => {
    const { row } = await pathRevision(ctx, "publisher");
    if (row.status !== "proposed") throw conflict("only a proposed revision can be approved");
    if (!mayApprove(row.author, ctx.principal.email)) throw conflict("two-person rule: the author cannot approve their own revision");
    return transition(ctx, row, "proposed", "approved", { approver: ctx.principal.email }, "revision.approved");
  }),

  /** Sets (or with `null`, clears) a tenant's enforcement mode for the next release. Admin only. */
  route("PUT", `/tenants/${SEG}/mode`, async (ctx) => {
    requireAdmin(ctx.principal);
    const tenant = tenantOf(ctx);
    const body = await readJson(ctx.request) as { setting?: unknown } | null;
    const setting = body?.setting === null ? null : TenantModeSetting.safeParse(body?.setting);
    if (setting !== null && !setting.success) throw invalid("body is {setting: \"shadow\" | \"enforce\" | {mode, allowStudentShadow?} | null}");
    await ctx.env.DB.batch([
      setting === null
        ? ctx.env.DB.prepare("DELETE FROM tenant_modes WHERE tenant = ?1").bind(tenant)
        : ctx.env.DB.prepare("INSERT INTO tenant_modes (tenant, setting_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (tenant) DO UPDATE SET setting_json = ?2, updated_by = ?3, updated_at = ?4")
          .bind(tenant, JSON.stringify(setting.data), ctx.principal.email, now()),
      auditStatement(ctx.env, ctx.principal.email, "tenant_mode.set", tenant, "tenant", tenant),
    ]);
    return json({ tenant, setting: setting === null ? null : setting.data });
  }),
];
