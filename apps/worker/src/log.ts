import type { Decision, DegradedReason, EnforcementMode, ErrorCode } from "@gmacko/hall-monitor-contracts";
import type { AuthFailure } from "./auth.ts";

/** Every event the Worker logs. Names are fixed so dashboards and alerts can rely on them. */
export type LogEvent =
  | "evaluation.completed"
  | "evaluation.replayed"
  | "evaluation.failed"
  | "batch.completed"
  | "receipt.read"
  | "auth.rejected"
  | "request.rejected"
  | "policy.overlay_clamped"
  | "shadow.refused"
  | "config.invalid"
  | "ratelimit.unavailable"
  | "replay_guard.unavailable"
  | "internal.error"
  | "telemetry.delivery_failed"
  | "telemetry.coverage_gap"
  | "telemetry.outbox_held";

/**
 * The only fields a log line may carry. All are identifiers, codes or counters; there is
 * deliberately no field that could hold request content, tokens or free-form error messages.
 */
export interface LogFields {
  readonly tenant?: string;
  readonly evaluationId?: string;
  /** The decision returned to the caller. */
  readonly decision?: Decision;
  /** Present on shadow-mode results. */
  readonly mode?: EnforcementMode;
  /** The decision a shadow-mode result would have enforced. */
  readonly shadowDecision?: Decision;
  readonly degraded?: DegradedReason;
  readonly latencyMs?: number;
  readonly attempts?: number;
  readonly errorCode?: ErrorCode;
  readonly authFailure?: AuthFailure;
  readonly status?: number;
  readonly route?: string;
  readonly items?: number;
  readonly errors?: number;
  readonly violations?: number;
  readonly profileId?: string;
  readonly variable?: "HM_TRUSTED_ISSUERS" | "HM_AUDIENCE" | "HM_POLICY_OVERLAYS" | "HM_TENANT_MODES" | "HM_RETENTION_SECONDS";
  /** An exception's class name, never its message. */
  readonly errorName?: string;
  /** Why telemetry coverage was lost, or why an attempt failed: fixed codes, never free text. */
  readonly reason?: "capacity" | "expired" | "revoked" | "error" | "timeout" | "unavailable" | "rejected" | "not_durable" | "invalid_ack" | "mismatched_ack" | "conflict";
  readonly count?: number;
}

/** Writes one structured JSON log line. */
export function log(level: "info" | "warn" | "error", event: LogEvent, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
