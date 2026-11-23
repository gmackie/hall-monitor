import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { applyOverlay, BUILTIN_PROFILES, MODEL_FAMILIES, PolicyOverlay, type PolicyProfile } from "@gmacko/hall-monitor-policy";
import type { Env } from "./env.ts";
import { invalid, notFound, segment } from "./http.ts";
import type { Ctx } from "./router.ts";

export type RevisionStatus = "draft" | "proposed" | "approved" | "published";

/** One stored profile revision, as the API returns it. */
export interface Revision {
  readonly id: string;
  readonly tenant: string;
  readonly profileId: string;
  readonly revision: string;
  readonly overlay: PolicyOverlay;
  readonly status: RevisionStatus;
  readonly studentFacing: boolean;
  readonly enforcesFamily: boolean;
  readonly waiverNoted: boolean;
  readonly author: string;
  readonly approver: string | null;
  readonly violations: readonly { field: string; floor: string; requested: string }[];
  readonly hasDiff: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RevisionRow {
  id: string; tenant: string; profile_id: string; revision: string; overlay_json: string; status: RevisionStatus;
  student_facing: number; enforces_family: number; waiver_noted: number; author: string; approver: string | null;
  violations_json: string; diff_report_json: string | null; created_at: string; updated_at: string;
}

export function revisionOf(row: RevisionRow): Revision {
  return {
    id: row.id, tenant: row.tenant, profileId: row.profile_id, revision: row.revision,
    overlay: JSON.parse(row.overlay_json) as PolicyOverlay, status: row.status,
    studentFacing: row.student_facing === 1, enforcesFamily: row.enforces_family === 1, waiverNoted: row.waiver_noted === 1,
    author: row.author, approver: row.approver, violations: JSON.parse(row.violations_json) as Revision["violations"],
    hasDiff: row.diff_report_json !== null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** The built-in floor for a profile id in the path, or 404. */
export function floorParam(raw: string): PolicyProfile {
  const profileId = segment(raw);
  const floor = Object.hasOwn(BUILTIN_PROFILES, profileId) ? BUILTIN_PROFILES[profileId] : undefined;
  if (floor === undefined) throw notFound("profile not found");
  return floor;
}

export function tenantOf(ctx: Ctx, index = 0): string {
  const tenant = segment(ctx.params[index]!);
  if (!OpaqueId.safeParse(tenant).success) throw invalid("invalid tenant");
  return tenant;
}

/**
 * Applies an overlay to its floor exactly as the evaluation Worker does, and reports what the
 * two-person rule needs: whether the effective profile is student-facing, whether any family
 * enforces, and every weakening field (clamped, so the draft cannot take effect as written).
 */
export function assessOverlay(floor: PolicyProfile, overlay: PolicyOverlay) {
  const { profile, violations } = applyOverlay(floor, { ...overlay, id: floor.id });
  const enforcesFamily = MODEL_FAMILIES.some((family) => overlay.routing?.[family]?.mode === "enforce");
  return { profile, violations, studentFacing: profile.studentFacing, enforcesFamily };
}

/** A tenant's revision by id, or 404 (another tenant's id reads as missing). */
export async function loadRevision(env: Env, tenant: string, profileId: string, id: string): Promise<RevisionRow> {
  const row = await env.DB.prepare("SELECT * FROM profile_revisions WHERE tenant = ?1 AND profile_id = ?2 AND id = ?3")
    .bind(tenant, profileId, id).first<RevisionRow>();
  if (row === null) throw notFound("revision not found");
  return row;
}

/** The tenant's latest published revision of each profile. */
export async function publishedRevisions(env: Env, tenant: string): Promise<Map<string, RevisionRow>> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM profile_revisions WHERE tenant = ?1 AND status = 'published' ORDER BY updated_at DESC, id DESC",
  ).bind(tenant).all<RevisionRow>();
  const latest = new Map<string, RevisionRow>();
  for (const row of results) if (!latest.has(row.profile_id)) latest.set(row.profile_id, row);
  return latest;
}
