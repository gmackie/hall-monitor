import { DurableObject } from "cloudflare:workers";
import type { EvaluationResult, ReceiptRecord } from "@gmacko/hall-monitor-contracts";
import type { Env } from "./env.ts";

/** Default retention for idempotency records and receipts: 24 hours. */
export const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * How long an in-flight reservation holds its key. A Worker that dies mid-evaluation leaves a
 * pending row; after this it no longer blocks a retry.
 */
export const PENDING_HOLD_MS = 2 * 60 * 1000;

/** What {@link IdempotencyStore.begin} found for a key. */
export type BeginOutcome =
  /** No live record: the key is now reserved for this request. */
  | { readonly kind: "started" }
  /** A completed evaluation of the same request: replay its result. */
  | { readonly kind: "replay"; readonly result: EvaluationResult }
  /** The key was used for a different request. */
  | { readonly kind: "conflict" }
  /** The same request is being evaluated right now. */
  | { readonly kind: "in_progress" };

/**
 * One tenant's idempotency records and receipts (one object per tenant, by name). It stores only
 * content-free data: the request digest, the result and the receipt record, which are
 * content-free by contract. Records expire after the retention period and are purged by alarm.
 */
export class IdempotencyStore extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #retentionMs: number;

  /** Creates the store and its tables. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#retentionMs = retentionSeconds(env) * 1000;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency (expires_at);
      CREATE TABLE IF NOT EXISTS receipts (
        evaluation_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_expiry ON receipts (expires_at);
    `);
  }

  /**
   * Looks up `key` and, when it is free, reserves it for a request with `digest`. The check and
   * the reservation are one step, so two concurrent identical requests cannot both evaluate.
   */
  async begin(key: string, digest: string): Promise<BeginOutcome> {
    const now = Date.now();
    const row = this.#sql
      .exec<{ digest: string; state: string; result: string | null }>(
        "SELECT digest, state, result FROM idempotency WHERE key = ? AND expires_at > ?",
        key,
        now,
      )
      .toArray()[0];
    if (row === undefined) {
      this.#sql.exec(
        "INSERT OR REPLACE INTO idempotency (key, digest, state, result, expires_at) VALUES (?, ?, 'pending', NULL, ?)",
        key,
        digest,
        now + PENDING_HOLD_MS,
      );
      await this.#scheduleCleanup(now + PENDING_HOLD_MS);
      return { kind: "started" };
    }
    if (row.digest !== digest) return { kind: "conflict" };
    if (row.state !== "done" || row.result === null) return { kind: "in_progress" };
    return { kind: "replay", result: JSON.parse(row.result) as EvaluationResult };
  }

  /** Records the result of a reserved request and its receipt record. */
  async complete(key: string, digest: string, result: EvaluationResult, record: Omit<ReceiptRecord, "expiresAt">): Promise<ReceiptRecord> {
    const expiresAt = Date.now() + this.#retentionMs;
    const stored: ReceiptRecord = { ...record, expiresAt: new Date(expiresAt).toISOString() };
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        "UPDATE idempotency SET state = 'done', result = ?, expires_at = ? WHERE key = ? AND digest = ?",
        JSON.stringify(result),
        expiresAt,
        key,
        digest,
      );
      this.#sql.exec(
        "INSERT OR REPLACE INTO receipts (evaluation_id, record, expires_at) VALUES (?, ?, ?)",
        result.evaluationId,
        JSON.stringify(stored),
        expiresAt,
      );
    });
    await this.#scheduleCleanup(expiresAt);
    return stored;
  }

  /** Releases a reservation whose evaluation failed, so the caller may retry with the same key. */
  async abandon(key: string, digest: string): Promise<void> {
    this.#sql.exec("DELETE FROM idempotency WHERE key = ? AND digest = ? AND state = 'pending'", key, digest);
  }

  /** The receipt record for an evaluation of this tenant, or null when unknown or expired. */
  async receipt(evaluationId: string): Promise<ReceiptRecord | null> {
    const row = this.#sql
      .exec<{ record: string }>("SELECT record FROM receipts WHERE evaluation_id = ? AND expires_at > ?", evaluationId, Date.now())
      .toArray()[0];
    return row === undefined ? null : (JSON.parse(row.record) as ReceiptRecord);
  }

  /** Purges expired rows and schedules the next purge. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.#sql.exec("DELETE FROM idempotency WHERE expires_at <= ?", now);
    this.#sql.exec("DELETE FROM receipts WHERE expires_at <= ?", now);
    const next = this.#sql
      .exec<{ next: number | null }>(
        "SELECT MIN(expires_at) AS next FROM (SELECT expires_at FROM idempotency UNION ALL SELECT expires_at FROM receipts)",
      )
      .one().next;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async #scheduleCleanup(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}

/** The configured retention, falling back to the default when unset or invalid. */
export function retentionSeconds(env: Pick<Env, "HM_RETENTION_SECONDS">): number {
  const value = Number(env.HM_RETENTION_SECONDS ?? DEFAULT_RETENTION_SECONDS);
  return Number.isInteger(value) && value > 0 && value <= 30 * 24 * 60 * 60 ? value : DEFAULT_RETENTION_SECONDS;
}
