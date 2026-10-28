import { DurableObject } from "cloudflare:workers";
import {
  TELEMETRY_V2_MAX_FUTURE_SKEW_MS,
  TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS,
  type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";

/**
 * Exact occurrence buckets are 15 UTC minutes. That is the finest unit every real UTC offset
 * (including :30 and :45 zones) shares, so W8 can later derive local hours from these rows
 * exactly. Nothing here is a date-free weekday/hour grouping.
 */
export const BUCKET_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_DEDUPE_ROWS = 50_000;

/**
 * A dedupe row must outlive the whole window in which its delivery could still be accepted
 * (occurrence + max age), plus the clock-skew margin. After that a replay's occurrence is
 * too old to be counted at all, so deleting the row cannot permit a recount. The row's expiry is
 * measured from the END of the occurrence's bucket (never earlier than the occurrence itself),
 * so it keeps no timestamp finer than the 15-minute bucket the rollup already holds.
 */
export const DEDUPE_RETENTION_AFTER_OCCURRENCE_MS = TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS + TELEMETRY_V2_MAX_FUTURE_SKEW_MS;

export interface IngestInput {
  /** Keyed digest of tenant + delivery ID. The raw delivery ID never reaches this object. */
  readonly deliveryKey: string;
  /** Digest of the exact signed body. Same key, different digest is a conflict. */
  readonly digest: string;
  readonly producerRevision: string;
  /** The validated pair: one content_evaluated, optionally one matching candidate_flagged. */
  readonly events: readonly TemporalMetricEvent[];
  readonly maxDedupeRows: number;
}

export type IngestOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "deduplicated" }
  /** The key is held with a different digest. */
  | { readonly kind: "conflict" }
  /** The occurrence is older than the accepted horizon: never counted, even if its state expired. */
  | { readonly kind: "stale" }
  | { readonly kind: "future" }
  | { readonly kind: "capacity" };

/** One exact chronological bucket. Counts only; there is no per-message row. */
export interface RollupRow {
  readonly bucketStart: string;
  readonly source: string;
  readonly gradeBand: string;
  readonly modality: string;
  readonly producerRevision: string;
  readonly evaluated: number;
  readonly candidate: number;
}

/** Operational health. Ingress time lives here only, never next to an occurrence bucket. */
export interface IngestHealth {
  readonly lastIngestAt: string | null;
  readonly committed: number;
  readonly deduplicated: number;
  readonly conflicts: number;
  readonly dedupeRows: number;
}

/**
 * One tenant's exact aggregates (one object per tenant, by name). Per delivery it keeps only a
 * short-lived protected dedupe digest; per occurrence bucket it keeps counters. A delivery's
 * dedupe state and its whole pair's counters change in ONE transaction, so a pair is counted
 * entirely or not at all, exactly once.
 */
export class TelemetryAggregateStore extends DurableObject<object> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_key TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_expiry ON deliveries (expires_at);
      CREATE TABLE IF NOT EXISTS rollups (
        bucket_start INTEGER NOT NULL,
        source TEXT NOT NULL,
        grade_band TEXT NOT NULL,
        modality TEXT NOT NULL,
        producer_revision TEXT NOT NULL,
        evaluated INTEGER NOT NULL,
        candidate INTEGER NOT NULL,
        PRIMARY KEY (bucket_start, source, grade_band, modality, producer_revision)
      );
      CREATE TABLE IF NOT EXISTS ingest_health (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_ingest_at INTEGER,
        committed INTEGER NOT NULL,
        deduplicated INTEGER NOT NULL,
        conflicts INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO ingest_health (id, last_ingest_at, committed, deduplicated, conflicts) VALUES (1, NULL, 0, 0, 0);
    `);
    // A restart must not leave dedupe state without a purge alarm.
    ctx.blockConcurrencyWhile(() => this.#scheduleEarliest());
  }

  /**
   * Counts one delivery's pair once. Everything between the dedupe lookup and the counter
   * increment is a single synchronous transaction, so concurrent, reordered or repeated
   * deliveries converge on the same totals.
   */
  async ingest(input: IngestInput): Promise<IngestOutcome> {
    const now = this.now();
    const first = input.events[0];
    if (first === undefined) return { kind: "stale" };
    const occurred = Date.parse(first.occurredAt);
    if (!Number.isFinite(occurred)) return { kind: "stale" };
    // The window is checked before the dedupe lookup, and dedupe state outlives it, so an old
    // re-signed replay is refused rather than counted again once its state has expired.
    if (now - occurred > TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS) return { kind: "stale" };
    if (occurred - now > TELEMETRY_V2_MAX_FUTURE_SKEW_MS) return { kind: "future" };

    // Assigned inside the transaction callback; "capacity" is what remains if no branch ran.
    let outcome = { kind: "capacity" } as IngestOutcome;
    this.ctx.storage.transactionSync(() => {
      const existing = this.#sql.exec<{ digest: string }>("SELECT digest FROM deliveries WHERE delivery_key = ?", input.deliveryKey).toArray()[0];
      if (existing !== undefined) {
        if (existing.digest === input.digest) {
          this.#touchHealth(now, "deduplicated");
          outcome = { kind: "deduplicated" };
        } else {
          this.#touchHealth(now, "conflicts");
          outcome = { kind: "conflict" };
        }
        return;
      }
      const rows = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries").one().n;
      if (rows >= input.maxDedupeRows) return;
      const bucketStart = Math.floor(occurred / BUCKET_MS) * BUCKET_MS;
      this.#sql.exec(
        "INSERT INTO deliveries (delivery_key, digest, expires_at) VALUES (?, ?, ?)",
        input.deliveryKey,
        input.digest,
        bucketStart + BUCKET_MS + DEDUPE_RETENTION_AFTER_OCCURRENCE_MS,
      );
      // One row per bucket and dimension set carries the whole pair: evaluated is always +1, and
      // candidate is +1 only when the same delivery carried its matching candidate event.
      this.#sql.exec(
        `INSERT INTO rollups (bucket_start, source, grade_band, modality, producer_revision, evaluated, candidate)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (bucket_start, source, grade_band, modality, producer_revision)
         DO UPDATE SET evaluated = evaluated + 1, candidate = candidate + excluded.candidate`,
        bucketStart,
        first.source,
        first.gradeBand,
        first.modality,
        input.producerRevision,
        input.events.length === 2 ? 1 : 0,
      );
      this.#touchHealth(now, "committed");
      this.afterIngestWrites();
      outcome = { kind: "committed" };
    });
    if (outcome.kind === "committed") await this.#scheduleEarliest();
    return outcome;
  }

  /** The exact chronological counters, oldest first. An internal read; no route exposes it yet. */
  async rollups(): Promise<readonly RollupRow[]> {
    return this.#sql
      .exec<{ bucket_start: number; source: string; grade_band: string; modality: string; producer_revision: string; evaluated: number; candidate: number }>(
        "SELECT * FROM rollups ORDER BY bucket_start, source, grade_band, modality, producer_revision",
      )
      .toArray()
      .map((row) => ({
        bucketStart: new Date(row.bucket_start).toISOString(),
        source: row.source,
        gradeBand: row.grade_band,
        modality: row.modality,
        producerRevision: row.producer_revision,
        evaluated: row.evaluated,
        candidate: row.candidate,
      }));
  }

  async health(): Promise<IngestHealth> {
    const row = this.#sql
      .exec<{ last_ingest_at: number | null; committed: number; deduplicated: number; conflicts: number }>("SELECT * FROM ingest_health WHERE id = 1")
      .one();
    const dedupeRows = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries").one().n;
    return {
      lastIngestAt: row.last_ingest_at === null ? null : new Date(row.last_ingest_at).toISOString(),
      committed: row.committed,
      deduplicated: row.deduplicated,
      conflicts: row.conflicts,
      dedupeRows,
    };
  }

  /** Purges dedupe state that can no longer matter, then re-arms for the next expiry. */
  override async alarm(): Promise<void> {
    this.#sql.exec("DELETE FROM deliveries WHERE expires_at <= ?", this.now());
    const next = this.#nextExpiry();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** The object's clock: the trusted ingress time. A seam so tests can age the object. */
  protected now(): number {
    return Date.now();
  }

  /** Runs inside the ingest transaction after every write; a seam for injecting a commit failure. */
  protected afterIngestWrites(): void {}

  #touchHealth(now: number, counter: "committed" | "deduplicated" | "conflicts"): void {
    this.#sql.exec(`UPDATE ingest_health SET last_ingest_at = ?, ${counter} = ${counter} + 1 WHERE id = 1`, now);
  }

  #nextExpiry(): number | null {
    return this.#sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM deliveries").one().next;
  }

  async #scheduleEarliest(): Promise<void> {
    const next = this.#nextExpiry();
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}
