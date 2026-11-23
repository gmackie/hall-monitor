import {
  ACTIVE_POINTER_KEY,
  canonical,
  type ConfigRelease,
  configReleaseDigest,
  parseConfigRelease,
  releaseObjectKey,
  type ReleaseOverlays,
  serializeConfigRelease,
  TenantModes,
} from "@gmacko/hall-monitor-config-release";
import type { PolicyOverlay } from "@gmacko/hall-monitor-policy";
import { auditStatement, newId } from "../audit.ts";
import type { Env } from "../env.ts";
import { ApiError, conflict, forbidden, json, notFound, segment } from "../http.ts";
import type { RevisionRow } from "../revisions.ts";
import { hasRole, hasRoleAnywhere, type Principal } from "../roles.ts";
import { route } from "../router.ts";
import { publishConflicts, releaseApprover } from "../two-person.ts";

interface ReleaseRow {
  release_id: string; digest: string; author: string; approver: string; created_at: string; activated_at: string | null; document_json: string;
}

function storage(env: Env): { kv: KVNamespace; r2: R2Bucket } {
  if (env.CONFIG_POINTER === undefined || env.CONFIG_RELEASES === undefined) throw new ApiError(503, "unavailable", "release storage is not bound");
  return { kv: env.CONFIG_POINTER, r2: env.CONFIG_RELEASES };
}

/** A release changes every tenant it names: the publisher needs `publisher` on each of them. */
function requirePublisherFor(principal: Principal, tenants: Iterable<string>): void {
  if (!hasRoleAnywhere(principal, "publisher")) throw forbidden();
  for (const tenant of tenants) if (!hasRole(principal, tenant, "publisher")) throw forbidden();
}

async function activePointer(env: Env): Promise<{ releaseId: string; digest: string } | null> {
  const text = await storage(env).kv.get(ACTIVE_POINTER_KEY);
  if (text === null) return null;
  try {
    return JSON.parse(text) as { releaseId: string; digest: string };
  } catch {
    return null;
  }
}

/** A release as one person may see it: only the tenants they can view are named. */
function summary(row: ReleaseRow, activeDigest: string | null, visible: (tenant: string) => boolean) {
  const document = JSON.parse(row.document_json) as ConfigRelease;
  const modes = Object.entries(document.tenantModes ?? {}).filter(([tenant]) => visible(tenant));
  return {
    releaseId: row.release_id, digest: row.digest, author: row.author, approver: row.approver, createdAt: row.created_at,
    activatedAt: row.activated_at, active: row.digest === activeDigest,
    tenants: Object.keys(document.overlays).filter(visible).sort(),
    profiles: Object.entries(document.overlays).filter(([tenant]) => visible(tenant)).flatMap(([tenant, profiles]) => Object.entries(profiles).map(([id, o]) => `${tenant}/${id}@${o.revision}`)),
    tenantModes: document.tenantModes === undefined ? null : Object.fromEntries(modes),
  };
}

/**
 * The release a publish would produce: for each tenant and profile, the most recently updated
 * revision that is approved or already published; plus tenant modes when any are set.
 */
async function candidate(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM profile_revisions WHERE status IN ('approved', 'published') ORDER BY updated_at DESC, id DESC").all<RevisionRow>();
  const chosen = new Map<string, RevisionRow>();
  for (const row of results) {
    const key = JSON.stringify([row.tenant, row.profile_id]);
    if (!chosen.has(key)) chosen.set(key, row);
  }
  const overlays: ReleaseOverlays = {};
  for (const row of chosen.values()) (overlays[row.tenant] ??= {})[row.profile_id] = JSON.parse(row.overlay_json) as PolicyOverlay;
  const modes = await env.DB.prepare("SELECT tenant, setting_json FROM tenant_modes ORDER BY tenant").all<{ tenant: string; setting_json: string }>();
  const tenantModes = modes.results.length === 0 ? undefined : TenantModes.parse(Object.fromEntries(modes.results.map((m) => [m.tenant, JSON.parse(m.setting_json)])));
  const fresh = [...chosen.values()].filter((row) => row.status === "approved");
  return { overlays, tenantModes, fresh };
}

export const releaseRoutes = [
  route("GET", "/releases", async ({ env, principal }) => {
    if (!hasRoleAnywhere(principal, "publisher")) throw forbidden();
    const pointer = await activePointer(env);
    const { results } = await env.DB.prepare("SELECT * FROM releases ORDER BY created_at DESC LIMIT 100").all<ReleaseRow>();
    const pending = await candidate(env);
    const modes = await env.DB.prepare("SELECT tenant, setting_json AS setting, updated_by AS updatedBy, updated_at AS updatedAt FROM tenant_modes ORDER BY tenant").all<{ tenant: string }>();
    const visible = (tenant: string) => hasRole(principal, tenant, "viewer");
    return json({
      active: pointer,
      releases: results.map((row) => summary(row, pointer?.digest ?? null, visible)),
      // Newly approved revisions on tenants this person cannot view are counted, not named.
      hiddenPending: pending.fresh.filter((row) => !visible(row.tenant)).length,
      tenantModes: modes.results.filter((m) => visible(m.tenant)),
      pending: pending.fresh.filter((row) => visible(row.tenant)).map((row) => ({ id: row.id, tenant: row.tenant, profileId: row.profile_id, revision: row.revision, author: row.author, approver: row.approver })),
    });
  }),

  /**
   * Publishes a release: builds it from every approved or published revision and the tenant modes,
   * applies the two-person rule to every newly included revision, stores it in R2 under its
   * digest, records it in D1, marks the revisions published and points KV at it.
   */
  route("POST", "/releases", async ({ env, principal }) => {
    const { kv, r2 } = storage(env);
    const { overlays, tenantModes, fresh } = await candidate(env);
    requirePublisherFor(principal, new Set([...fresh.map((row) => row.tenant), ...Object.keys(tenantModes ?? {})]));
    const blocked = publishConflicts(principal.email, fresh.map((row) => ({ ...row, studentFacing: row.student_facing === 1, enforcesFamily: row.enforces_family === 1 })));
    if (blocked.length > 0) throw conflict(`two-person rule: you wrote ${blocked.length} student-facing or enforcing revision(s) in this release; another publisher must publish it`);

    const pointer = await activePointer(env);
    if (fresh.length === 0 && pointer === null && tenantModes === undefined) throw conflict("nothing to publish: approve a revision or set a tenant mode first");
    if (fresh.length === 0 && pointer !== null) {
      const current = await env.DB.prepare("SELECT document_json FROM releases WHERE digest = ?1").bind(pointer.digest).first<{ document_json: string }>();
      const doc = current === null ? null : JSON.parse(current.document_json) as ConfigRelease;
      if (doc !== null && canonical([doc.overlays, doc.tenantModes ?? null]) === canonical([overlays, tenantModes ?? null])) throw conflict("nothing to publish: the active release already carries this configuration");
    }

    const release = parseConfigRelease({
      schemaVersion: "1.0", releaseId: newId("rel"), createdAt: new Date().toISOString(),
      author: principal.email,
      approver: releaseApprover(principal.email, fresh.map((row) => ({ author: row.author, approver: row.approver, studentFacing: row.student_facing === 1, enforcesFamily: row.enforces_family === 1 }))),
      overlays, ...(tenantModes === undefined ? {} : { tenantModes }),
    });
    const digest = await configReleaseDigest(release);
    const body = serializeConfigRelease(release);
    await r2.put(releaseObjectKey(digest), body, { httpMetadata: { contentType: "application/json" }, customMetadata: { releaseId: release.releaseId } });
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO releases (release_id, digest, author, approver, created_at, activated_at, document_json) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)")
        .bind(release.releaseId, digest, release.author, release.approver, at, body),
      ...fresh.map((row) => env.DB.prepare("UPDATE profile_revisions SET status = 'published', updated_at = ?1 WHERE id = ?2 AND tenant = ?3 AND status = 'approved'").bind(at, row.id, row.tenant)),
      auditStatement(env, principal.email, "release.published", "*", "release", release.releaseId),
    ]);
    await kv.put(ACTIVE_POINTER_KEY, JSON.stringify({ releaseId: release.releaseId, digest }));
    return json({ releaseId: release.releaseId, digest, revisions: fresh.length }, 201);
  }),

  /** Points the Worker at an earlier release (rollback). Its stored body must still verify. */
  route("POST", "/releases/([A-Za-z0-9][A-Za-z0-9._-]*):activate", async ({ env, principal, params }) => {
    const { kv, r2 } = storage(env);
    const row = await env.DB.prepare("SELECT * FROM releases WHERE release_id = ?1").bind(segment(params[0]!)).first<ReleaseRow>();
    if (row === null) throw notFound("release not found");
    const document = JSON.parse(row.document_json) as ConfigRelease;
    requirePublisherFor(principal, new Set([...Object.keys(document.overlays), ...Object.keys(document.tenantModes ?? {})]));
    const stored = await r2.get(releaseObjectKey(row.digest));
    if (stored === null || (await configReleaseDigest(parseConfigRelease(JSON.parse(await stored.text())))) !== row.digest) {
      throw new ApiError(409, "conflict", "the stored release no longer verifies; it cannot be activated");
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE releases SET activated_at = ?1 WHERE release_id = ?2").bind(new Date().toISOString(), row.release_id),
      auditStatement(env, principal.email, "release.activated", "*", "release", row.release_id),
    ]);
    await kv.put(ACTIVE_POINTER_KEY, JSON.stringify({ releaseId: row.release_id, digest: row.digest }));
    return json({ releaseId: row.release_id, digest: row.digest });
  }),
];
