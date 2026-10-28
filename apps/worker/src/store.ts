import { DurableObject } from "cloudflare:workers";
import type { EvaluationResult, ReceiptRecord } from "@gmacko/hall-monitor-contracts";
import {
  grantAllowsBatch,
  parseTelemetryDeliveryV2,
  parseTelemetryProducerTenantsV2,
  type TelemetryProducerTenantsV2,
  type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { sendDeliveryV2, type TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

/** Default retention for idempotency records and receipts: 24 hours. */
export const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * How long an in-flight reservation holds its key. A Worker that dies mid-evaluation leaves a
 * pending row; after this it no longer blocks a retry.
 */
export const PENDING_HOLD_MS = 2 * 60 * 1000;

/** Telemetry delivery pacing (HM-20): bounded exponential backoff, a bounded batch per alarm. */
export const OUTBOX_BACKOFF_BASE_MS = 30 * 1000;
export const OUTBOX_BACKOFF_MAX_MS = 15 * 60 * 1000;
export const OUTBOX_BATCH_PER_ALARM = 10;
export const DELIVERY_TIMEOUT_MS = 5000;
/**
 * How long coarse coverage-gap evidence is kept. A default pending the separately approved TTLs
 * of W8; it bounds the gap table to (hours retained x reasons) rows.
 */
export const GAP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Why telemetry for an evaluation will never reach the receiver. */
export type GapReason = "capacity" | "expired" | "revoked" | "error" | "conflict";

/**
 * What the Worker hands {@link IdempotencyStore.complete} to persist atomically with the result:
 * either the content-free delivery to queue, or a note that one could not even be built.
 */
export type TelemetryInput =
  | {
      readonly kind: "delivery";
      readonly deliveryId: string;
      readonly digest: string;
      /** The exact signed bytes: protected envelope with the frozen occurrence time. */
      readonly payload: string;
      readonly occurredAtMs: number;
      readonly retryHorizonMs: number;
      readonly maxRows: number;
      readonly maxBytes: number;
    }
  | { readonly kind: "gap"; readonly occurredAtMs: number; readonly reason: "error" };

/** Operator-visible telemetry state: what is queued and where analytics are known to be incomplete. */
export interface TelemetryState {
  readonly pending: number;
  readonly pendingBytes: number;
  /** Deliveries that have been attempted at least once and not yet acknowledged. */
  readonly retrying: number;
  readonly gaps: readonly { readonly hourStart: string; readonly reason: GapReason; readonly lost: number }[];
}

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

interface OutboxRow extends Record<string, SqlStorageValue> {
  delivery_id: string;
  tenant: string;
  digest: string;
  payload: string;
  occurred_at: number;
  attempts: number;
  next_attempt_at: number;
  deadline_at: number;
}

/**
 * One tenant's idempotency records and receipts (one object per tenant, by name). It stores only
 * content-free data: the request digest, the result and the receipt record, which are
 * content-free by contract. Records expire after the retention period and are purged by alarm.
 *
 * It also holds the tenant's telemetry outbox (HM-20): a queued v2 delivery is written in the SAME
 * transaction as the result and receipt that caused it, and the one alarm serves both cleanup and
 * delivery. A row leaves the outbox only on a verified durable acknowledgment, or as a counted
 * coverage gap (capacity, expiry, revocation); it never just disappears.
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
      CREATE TABLE IF NOT EXISTS telemetry_outbox (
        delivery_id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        digest TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS telemetry_outbox_due ON telemetry_outbox (next_attempt_at);
      CREATE INDEX IF NOT EXISTS telemetry_outbox_deadline ON telemetry_outbox (deadline_at);
      CREATE TABLE IF NOT EXISTS telemetry_gaps (
        hour_start INTEGER NOT NULL,
        reason TEXT NOT NULL,
        lost INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (hour_start, reason)
      );
    `);
    // A restart may find committed outbox rows whose alarm was never set (or was lost): make sure
    // the earliest pending work has an alarm before serving anything.
    ctx.blockConcurrencyWhile(() => this.#scheduleEarliest());
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
      await this.#scheduleAt(now + PENDING_HOLD_MS);
      return { kind: "started" };
    }
    if (row.digest !== digest) return { kind: "conflict" };
    if (row.state !== "done" || row.result === null) return { kind: "in_progress" };
    return { kind: "replay", result: JSON.parse(row.result) as EvaluationResult };
  }

  /**
   * Records the result of a reserved request and its receipt record. When `telemetry` is given,
   * its outbox row (or, if the outbox is full, a coverage-gap count) is written in the same
   * transaction: either the result, receipt and telemetry state all commit, or none do.
   */
  async complete(
    key: string,
    digest: string,
    result: EvaluationResult,
    record: Omit<ReceiptRecord, "expiresAt">,
    telemetry?: TelemetryInput,
  ): Promise<ReceiptRecord> {
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
      if (telemetry !== undefined) this.#queueTelemetry(record.tenantId, telemetry);
      this.afterCompletionWrites();
    });
    await this.#scheduleEarliest();
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

  /** Queued deliveries and known coverage gaps. Counts and UTC hours only; no IDs or payloads. */
  async telemetryState(): Promise<TelemetryState> {
    const totals = this.#sql
      .exec<{ n: number; bytes: number; retrying: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes, COALESCE(SUM(attempts > 0), 0) AS retrying FROM telemetry_outbox",
      )
      .one();
    const gaps = this.#sql
      .exec<{ hour_start: number; reason: GapReason; lost: number }>(
        "SELECT hour_start, reason, lost FROM telemetry_gaps WHERE expires_at > ? ORDER BY hour_start, reason",
        Date.now(),
      )
      .toArray()
      .map((row) => ({ hourStart: new Date(row.hour_start).toISOString(), reason: row.reason, lost: row.lost }));
    return { pending: totals.n, pendingBytes: totals.bytes, retrying: totals.retrying, gaps };
  }

  /**
   * One alarm for everything time-driven: purge expired records, expire outbox rows past their
   * retry horizon (as counted gaps), deliver what is due, then re-arm for the earliest next work.
   * It never throws: a failing alarm is retried by the runtime on its own schedule, which would
   * only repeat the same failure.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.#sql.exec("DELETE FROM idempotency WHERE expires_at <= ?", now);
    this.#sql.exec("DELETE FROM receipts WHERE expires_at <= ?", now);
    this.#sql.exec("DELETE FROM telemetry_gaps WHERE expires_at <= ?", now);
    try {
      this.#expireOutbox(now);
      await this.#deliverDue(now);
    } catch (error) {
      log("error", "internal.error", { route: "telemetry.alarm", errorName: error instanceof Error ? error.name.slice(0, 64) : typeof error });
    }
    const next = this.#nextWake();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /**
   * The tenants currently enrolled for v2 delivery, or null when v2 is off or its configuration is
   * invalid. Read per attempt so disabling or revoking takes effect on the next retry. (A
   * protected seam, so a test can change enrolment without rebuilding the object.)
   */
  protected async producerGrants(): Promise<TelemetryProducerTenantsV2 | null> {
    return this.env.HM_TELEMETRY_V2_ENABLED === "true" ? parseTelemetryProducerTenantsV2(this.env.HM_TELEMETRY_V2_TENANTS) : null;
  }

  /** The service binding deliveries go to. A seam so a test can substitute a collector. */
  protected collector(): TelemetryBinding | undefined {
    return this.env.METRICS_COLLECTOR;
  }

  /** Delay before a new row's first attempt: none in production, so delivery follows the commit. */
  protected firstAttemptDelayMs(): number {
    return 0;
  }

  /** How long one delivery attempt may take before it counts as failed. */
  protected deliveryTimeoutMs(): number {
    return DELIVERY_TIMEOUT_MS;
  }

  /** Runs inside the completion transaction after every write; a seam for injecting a commit failure. */
  protected afterCompletionWrites(): void {}

  #queueTelemetry(tenant: string, telemetry: TelemetryInput): void {
    if (telemetry.kind === "gap") {
      this.#recordGap(telemetry.occurredAtMs, telemetry.reason);
      return;
    }
    const { n, bytes } = this.#sql
      .exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes FROM telemetry_outbox")
      .one();
    const size = new TextEncoder().encode(telemetry.payload).byteLength;
    if (n >= telemetry.maxRows || bytes + size > telemetry.maxBytes) {
      this.#recordGap(telemetry.occurredAtMs, "capacity");
      return;
    }
    try {
      this.#sql.exec(
        "INSERT INTO telemetry_outbox (delivery_id, tenant, digest, payload, occurred_at, attempts, next_attempt_at, deadline_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        telemetry.deliveryId,
        tenant,
        telemetry.digest,
        telemetry.payload,
        telemetry.occurredAtMs,
        Date.now() + this.firstAttemptDelayMs(),
        telemetry.occurredAtMs + telemetry.retryHorizonMs,
      );
    } catch {
      // A rejected telemetry row (e.g. a duplicate delivery ID) must not fail the moderation
      // result committing alongside it; the statement left no row, so count it as lost coverage.
      this.#recordGap(telemetry.occurredAtMs, "error");
    }
  }

  /** Counts one lost delivery against the occurrence's UTC hour. Bounded: hours x reasons rows. */
  #recordGap(occurredAtMs: number, reason: GapReason): void {
    const hourStart = Math.floor(occurredAtMs / HOUR_MS) * HOUR_MS;
    this.#sql.exec(
      `INSERT INTO telemetry_gaps (hour_start, reason, lost, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (hour_start, reason) DO UPDATE SET lost = lost + 1, expires_at = MAX(expires_at, excluded.expires_at)`,
      hourStart,
      reason,
      Date.now() + GAP_RETENTION_MS,
    );
    log("warn", "telemetry.coverage_gap", { reason, count: 1 });
  }

  /** Rows whose retry horizon has passed become gaps, in one transaction. */
  #expireOutbox(now: number): void {
    this.ctx.storage.transactionSync(() => {
      const expired = this.#sql.exec<OutboxRow>("SELECT * FROM telemetry_outbox WHERE deadline_at <= ?", now).toArray();
      for (const row of expired) {
        this.#recordGap(row.occurred_at, "expired");
        this.#sql.exec("DELETE FROM telemetry_outbox WHERE delivery_id = ?", row.delivery_id);
      }
    });
  }

  async #deliverDue(now: number): Promise<void> {
    const due = this.#sql
      .exec<OutboxRow>(
        "SELECT * FROM telemetry_outbox WHERE next_attempt_at <= ? AND deadline_at > ? ORDER BY next_attempt_at LIMIT ?",
        now,
        now,
        OUTBOX_BATCH_PER_ALARM,
      )
      .toArray();
    if (due.length === 0) return;
    // Enrolment is re-read on every attempt: a disabled or revoked tenant sends nothing more, and
    // its queued rows are dropped as counted gaps rather than kept past the withdrawal.
    const grants = await this.producerGrants();
    for (const row of due) {
      const grant = grants?.get(row.tenant);
      let events: readonly TemporalMetricEvent[];
      try {
        events = parseTelemetryDeliveryV2(JSON.parse(row.payload)).events;
      } catch {
        this.#dropRow(row, "error");
        continue;
      }
      if (grant === undefined || !grantAllowsBatch(grant, { schemaVersion: 1, events })) {
        this.#dropRow(row, "revoked");
        continue;
      }
      const binding = this.collector();
      const outcome = binding === undefined
        ? ({ kind: "retry", reason: "unavailable" } as const)
        : await sendDeliveryV2(binding, row.tenant, grant.signingKey, row.payload, row.digest, { timeoutMs: this.deliveryTimeoutMs() });
      switch (outcome.kind) {
        case "acked":
          this.#sql.exec("DELETE FROM telemetry_outbox WHERE delivery_id = ?", row.delivery_id);
          break;
        case "conflict":
          this.#dropRow(row, "conflict");
          break;
        case "retry": {
          const attempts = row.attempts + 1;
          this.#sql.exec(
            "UPDATE telemetry_outbox SET attempts = ?, next_attempt_at = ? WHERE delivery_id = ?",
            attempts,
            Date.now() + retryDelayMs(attempts),
            row.delivery_id,
          );
          log("warn", "telemetry.delivery_failed", { tenant: row.tenant, reason: outcome.reason, attempts });
          break;
        }
      }
    }
  }

  /** Stops delivering a row and counts it as lost coverage, atomically. */
  #dropRow(row: OutboxRow, reason: GapReason): void {
    this.ctx.storage.transactionSync(() => {
      this.#recordGap(row.occurred_at, reason);
      this.#sql.exec("DELETE FROM telemetry_outbox WHERE delivery_id = ?", row.delivery_id);
    });
  }

  /** The earliest time anything in this object needs attention, or null when idle. */
  #nextWake(): number | null {
    return this.#sql
      .exec<{ next: number | null }>(
        `SELECT MIN(at) AS next FROM (
           SELECT MIN(expires_at) AS at FROM idempotency
           UNION ALL SELECT MIN(expires_at) FROM receipts
           UNION ALL SELECT MIN(expires_at) FROM telemetry_gaps
           UNION ALL SELECT MIN(next_attempt_at) FROM telemetry_outbox
           UNION ALL SELECT MIN(deadline_at) FROM telemetry_outbox
         )`,
      )
      .one().next;
  }

  /** Arms the alarm for the earliest pending work, never postponing one that is already earlier. */
  async #scheduleEarliest(): Promise<void> {
    const next = this.#nextWake();
    if (next !== null) await this.#scheduleAt(next);
  }

  async #scheduleAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}

/** Delay before retry number `attempts` (1-based): 30 s doubling to a 15 minute cap. */
export function retryDelayMs(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_MAX_MS);
}

/** The configured retention, falling back to the default when unset or invalid. */
export function retentionSeconds(env: Pick<Env, "HM_RETENTION_SECONDS">): number {
  const value = Number(env.HM_RETENTION_SECONDS ?? DEFAULT_RETENTION_SECONDS);
  return Number.isInteger(value) && value > 0 && value <= 30 * 24 * 60 * 60 ? value : DEFAULT_RETENTION_SECONDS;
}
