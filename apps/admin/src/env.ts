import type { EvaluationPage, EvaluationQuery, EvaluationRecord } from "@gmacko/hall-monitor-contracts";

/**
 * The evaluation Worker's `AdminRpc` entrypoint, as far as the admin Worker calls it. Bound as a
 * service binding (`EVALUATOR`, `entrypoint: "AdminRpc"`); it is never reachable over HTTP.
 */
export interface EvaluatorRpc {
  listEvaluations(tenant: string, query: EvaluationQuery): Promise<EvaluationPage>;
  getEvaluation(tenant: string, evaluationId: string): Promise<EvaluationRecord | null>;
}

/** The admin Worker's bindings and configuration. */
export interface Env {
  /** Static SPA assets (public/). */
  readonly ASSETS?: Fetcher;
  /** D1 `hm-control`: roles, profile revisions, releases, label sets and the audit log. */
  readonly DB: D1Database;
  /** The evaluation Worker's AdminRpc entrypoint. */
  readonly EVALUATOR?: EvaluatorRpc;
  /** The active config-release pointer the evaluation Worker reads (key `active`). */
  readonly CONFIG_POINTER?: KVNamespace;
  /** Immutable, digest-addressed config releases (`releases/<digest>.json`). */
  readonly CONFIG_RELEASES?: R2Bucket;
  /** Cloudflare Access team domain, e.g. `example.cloudflareaccess.com`. Without it, every API call is 503. */
  readonly HM_ADMIN_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. Without it, every API call is 503. */
  readonly HM_ADMIN_ACCESS_AUD?: string;
  /** Comma-separated or JSON-array emails that always hold the global `admin` role (secret). */
  readonly HM_ADMIN_BOOTSTRAP_EMAILS?: string;
  /** JSON array of tenant ids the global admin can view; defaults to `["playtrek","playtrek-beta"]`. */
  readonly HM_ADMIN_TENANTS?: string;
}
