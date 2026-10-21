import type { WorkersAiBinding } from "@gmacko/hall-monitor-clef";
import type { IdempotencyStore } from "./store.ts";

/** The Workers Rate Limiting binding, as far as this Worker uses it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The Worker's bindings and configuration. None of these values is a secret. */
export interface Env {
  /** Per-tenant idempotency records and receipts. */
  readonly IDEMPOTENCY_STORE: DurableObjectNamespace<IdempotencyStore>;
  /** Workers AI, for the Clef classifier. Without it the classifier is unavailable. */
  readonly AI?: WorkersAiBinding;
  /** Per-tenant request limiter. Without it, no rate limit is applied. */
  readonly TENANT_RATE_LIMITER?: RateLimiter;
  /** JSON list of trusted issuers: `[{ iss, jwks: { keys }, audiences? }]`. */
  readonly HM_TRUSTED_ISSUERS?: string;
  /** The audience service tokens must name, unless an issuer lists its own. */
  readonly HM_AUDIENCE?: string;
  /** JSON policy overlays: `{ [tenant]: { [profileId]: PolicyOverlay } }`. */
  readonly HM_POLICY_OVERLAYS?: string;
  /** AI Gateway id to route Clef calls through. */
  readonly HM_AI_GATEWAY_ID?: string;
  /** How long idempotency records and receipts are kept, in seconds. Defaults to 24 hours. */
  readonly HM_RETENTION_SECONDS?: string;
}
