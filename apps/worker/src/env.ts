import type { WorkersAiBinding } from "@gmacko/hall-monitor-clef";
import type { TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";
import type { TokenReplayGuard } from "./replay.ts";
import type { IdempotencyStore } from "./store.ts";

/** The Workers Rate Limiting binding, as far as this Worker uses it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The Worker's bindings and configuration. Everything but `HM_AUDIENCE` is deployed as a secret,
 * so a deploy never overwrites it (see wrangler.jsonc); only `HM_DIGEST_KEY` is confidential.
 */
export interface Env {
  /** Per-tenant idempotency records and receipts. */
  readonly IDEMPOTENCY_STORE: DurableObjectNamespace<IdempotencyStore>;
  /** Service-token ids already presented. Without it, every authenticated route fails closed. */
  readonly TOKEN_REPLAY_GUARD?: DurableObjectNamespace<TokenReplayGuard>;
  /** Workers AI, for the Clef classifier. Without it the classifier is unavailable. */
  readonly AI?: WorkersAiBinding;
  /** Optional internal service binding; absent by default, no external metric transport. */
  readonly METRICS_COLLECTOR?: TelemetryBinding;
  /** Explicit opt-in switch: only the exact string "true" enables emission. */
  readonly HM_TELEMETRY_ENABLED?: string;
  /** Strict JSON per-tenant source, allowed grade bands and HMAC keys; stored as secret. */
  readonly HM_TELEMETRY_TENANTS?: string;
  /**
   * Separate opt-in for the v2 durable outbox (HM-20). Only the exact string "true" enables it;
   * it never reads or changes the v1 settings above. Also requires `METRICS_COLLECTOR`.
   */
  readonly HM_TELEMETRY_V2_ENABLED?: string;
  /**
   * Strict JSON per-tenant v2 enrolment: `{ [tenant]: { source, gradeBands, signingKey,
   * producerRevision } }`; stored as a secret. `producerRevision` is server-owned and frozen into
   * each outbox row when it is written.
   */
  readonly HM_TELEMETRY_V2_TENANTS?: string;
  /** Optional v2 bounds; invalid values fall back to the defaults (500 rows, 1 MiB, 6 hours). */
  readonly HM_TELEMETRY_OUTBOX_MAX_ROWS?: string;
  readonly HM_TELEMETRY_OUTBOX_MAX_BYTES?: string;
  /** Seconds after the occurrence a delivery may still be retried; capped at 12 hours. */
  readonly HM_TELEMETRY_RETRY_HORIZON_SECONDS?: string;
  /** Per-tenant request limiter. Without it, no rate limit is applied. */
  readonly TENANT_RATE_LIMITER?: RateLimiter;
  /** JSON list of trusted issuers: `[{ iss, jwks: { keys }, audiences? }]`. */
  readonly HM_TRUSTED_ISSUERS?: string;
  /** The audience service tokens must name, unless an issuer lists its own. */
  readonly HM_AUDIENCE?: string;
  /** JSON policy overlays: `{ [tenant]: { [profileId]: PolicyOverlay } }`. */
  readonly HM_POLICY_OVERLAYS?: string;
  /**
   * JSON enforcement modes by tenant: `{ [tenant]: "shadow" | "enforce" | { mode, allowStudentShadow? } }`.
   * Unlisted tenants, and every tenant when the JSON is invalid, are enforced.
   */
  readonly HM_TENANT_MODES?: string;
  /** AI Gateway id to route Clef calls through. */
  readonly HM_AI_GATEWAY_ID?: string;
  /**
   * Secret (set with `wrangler secret put`, at least 32 characters) that keys the request digests
   * stored for idempotency. Without it, evaluations fail closed.
   */
  readonly HM_DIGEST_KEY?: string;
  /** How long idempotency records and receipts are kept, in seconds. Defaults to 24 hours. */
  readonly HM_RETENTION_SECONDS?: string;
}
