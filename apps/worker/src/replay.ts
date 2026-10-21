import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

/**
 * Remembers the `(iss, jti)` pairs of service tokens already presented, so each token is accepted
 * once. A row lives until its token can no longer verify (`exp` plus the clock skew), after which
 * the token is rejected as expired anyway; an alarm purges expired rows.
 *
 * Objects are named by issuer and tenant ({@link replayGuardName}). Every presentation of one
 * token carries the same signed claims, so they all reach the same object, whose single-threaded
 * execution makes the check and the insert one step: of two simultaneous uses, exactly one wins.
 * Rows hold only the issuer, the token id and an expiry; never the token or any request data.
 */
export class TokenReplayGuard extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  /** Creates the guard and its table. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS seen_tokens (
        issuer TEXT NOT NULL,
        jti TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (issuer, jti)
      );
      CREATE INDEX IF NOT EXISTS seen_tokens_expiry ON seen_tokens (expires_at);
    `);
  }

  /**
   * Records the first use of `(issuer, jti)` until `expiresAtMs` and returns true, or returns
   * false when the pair was already used and has not expired. There is no await between the read
   * and the write, so concurrent claims of one pair cannot both succeed.
   */
  async claim(issuer: string, jti: string, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    const seen = this.#sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM seen_tokens WHERE issuer = ? AND jti = ? AND expires_at > ?", issuer, jti, now)
      .toArray()[0];
    if (seen !== undefined) return false;
    this.#sql.exec("INSERT OR REPLACE INTO seen_tokens (issuer, jti, expires_at) VALUES (?, ?, ?)", issuer, jti, expiresAtMs);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAtMs) await this.ctx.storage.setAlarm(expiresAtMs);
    return true;
  }

  /** Purges expired rows and schedules the next purge. */
  override async alarm(): Promise<void> {
    this.#sql.exec("DELETE FROM seen_tokens WHERE expires_at <= ?", Date.now());
    const next = this.#sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM seen_tokens").one().next;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

/**
 * The guard object for a token. Sharded by issuer and tenant to spread load; any key derived from
 * the signed claims would do, since a replay presents identical claims.
 */
export function replayGuardName(issuer: string, tenant: string): string {
  return JSON.stringify(["jti", issuer, tenant]);
}
