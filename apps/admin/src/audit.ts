import type { Env } from "./env.ts";

/** Every action the audit log records. Rows hold who, what and which ids, never content. */
export type AuditAction =
  | "role.granted"
  | "role.revoked"
  | "revision.created"
  | "revision.routing_updated"
  | "revision.diffed"
  | "revision.proposed"
  | "revision.approved"
  | "release.published"
  | "release.activated"
  | "tenant_mode.set"
  | "label_set.imported"
  | "label.recorded"
  | "adjudication.recorded"
  | "predictions.imported"
  | "calibration.scored";

/** A statement that appends one audit row, for batching with the mutation it records. */
export function auditStatement(env: Env, actor: string, action: AuditAction, tenant: string, targetType: string, targetId: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO audit_log (id, at, actor, action, tenant, target_type, target_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(newId("aud"), new Date().toISOString(), actor, action, tenant, targetType, targetId);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
