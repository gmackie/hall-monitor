import { DurableObject } from "cloudflare:workers";
import {
  TELEMETRY_V2_MAX_FUTURE_SKEW_MS,
  TELEMETRY_V2_MAX_OCCURRENCE_AGE_MS,
  type TelemetryRetentionPolicy,
  type TemporalMetricEvent,
} from "@gmacko/hall-monitor-telemetry-contracts";
import type { CalendarKind } from "@gmacko/hall-monitor-temporal-analytics";
import {
  DEDUPE_RETENTION_AFTER_OCCURRENCE_MS,
  bucketEnd,
  bucketProvisional,
  ceilToBucket,
  dedupeExpiry,
  healthExpiry,
  rollupExpiry,
  toApplied,
  type AppliedRetention,
} from "./retention.ts";
import { BUCKET_MS, bucketStartOf, type TrustedDimensions } from "./time.ts";

export { BUCKET_MS, DEDUPE_RETENTION_AFTER_OCCURRENCE_MS };
export const DEFAULT_MAX_DEDUPE_ROWS = 50_000;

/** Stand-in for "no policy applied yet" in expiry arithmetic: far beyond any real timestamp. */
const NO_LIMIT = 2 ** 52;
/** Rollups written before W8a had no policy; they are kept no longer than this. Ten years. */
const LEGACY_MAX_RETENTION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface IngestInput {
  /**
   * Domain-separated SHA-256 of tenant + delivery ID (not a keyed MAC). The raw delivery ID never
   * reaches this object.
   */
  readonly deliveryKey: string;
  /** Digest of the exact signed body. Same key, different digest is a conflict. */
  readonly digest: string;
  readonly producerRevision: string;
  /** The validated pair: one content_evaluated, optionally one matching candidate_flagged. */
  readonly events: readonly TemporalMetricEvent[];
  readonly maxDedupeRows: number;
  /**
   * The server-owned dimensions for this occurrence's bucket, resolved by the Worker from the
   * tenant's trusted configuration. Nothing the producer sent selects them.
   */
  readonly time: TrustedDimensions;
  /** The approved retention policy in force for this tenant. Checked against this object's clock. */
  readonly retention: TelemetryRetentionPolicy;
}

export type IngestOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "deduplicated" }
  /** The key is held with a different digest. */
  | { readonly kind: "conflict" }
  /** The occurrence is older than the accepted horizon, or before a revocation: never counted. */
  | { readonly kind: "stale" }
  | { readonly kind: "future" }
  /** The retention policy is not in force at this object's clock. Nothing is stored. */
  | { readonly kind: "retention" }
  /** The bucket already holds different local dimensions under the same revision ids. */
  | { readonly kind: "config_conflict" }
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
  /**
   * Trusted local time pinned when the bucket was first written, or null on a row written before
   * W8a (it carries no zone or calendar, and none is invented for it).
   */
  readonly time: TrustedDimensions | null;
  /** Committed deliveries that changed this bucket; each one advances it exactly once. Null pre-W8a. */
  readonly revision: number | null;
  /** Of those, the commits that arrived after the bucket had closed (corrections). Null pre-W8a. */
  readonly lateRevisions: number | null;
  /** True while a late delivery could still revise this bucket. Null when unknown (pre-W8a). */
  readonly provisional: boolean | null;
  /**
   * Whether the source's producer is known to have observed the whole bucket. Always "unavailable"
   * here: the receiver holds no producer coverage evidence (that is W8b), so a count is never
   * complete and a missing bucket is never a verified zero.
   */
  readonly completeness: "unavailable";
}

/** Operational health. Ingress time lives here only, never next to an occurrence bucket. */
export interface IngestHealth {
  readonly lastIngestAt: string | null;
  readonly committed: number;
  readonly deduplicated: number;
  readonly conflicts: number;
  readonly dedupeRows: number;
  /** A healthy receiver does not establish producer coverage. Always "unavailable" until W8b. */
  readonly producerCoverage: "unavailable";
}

export interface RetentionState {
  readonly state: "active" | "revoked";
  readonly policyRevision: string;
  readonly revokedFloor: string | null;
}

interface RetentionRow extends Record<string, SqlStorageValue> {
  state: "active" | "revoked";
  policy_revision: string;
  rollup_ms: number;
  revoked_floor: number | null;
}

interface RollupDbRow extends Record<string, SqlStorageValue> {
  bucket_start: number;
  source: string;
  grade_band: string;
  modality: string;
  producer_revision: string;
  config_revision: string;
  calendar_revision: string;
  time_zone: string;
  local_date: string;
  local_hour: number;
  weekday: number;
  week_start: string;
  utc_offset_minutes: number;
  calendar_kind: CalendarKind;
  evaluated: number;
  candidate: number;
  revision: number;
  late_revisions: number;
}

interface LegacyDbRow extends Record<string, SqlStorageValue> {
  bucket_start: number;
  source: string;
  grade_band: string;
  modality: string;
  producer_revision: string;
  evaluated: number;
  candidate: number;
}

/**
 * One tenant's exact aggregates (one object per tenant, by name). Per delivery it keeps only a
 * short-lived protected dedupe digest; per occurrence bucket it keeps counters pinned to the trusted
 * local time of that occurrence. A delivery's dedupe state and its whole pair's counters change in
 * ONE transaction, so a pair is counted entirely or not at all, exactly once.
 *
 * Everything it stores expires under the tenant's approved retention policy, enforced by one alarm
 * (earliest of all expiries, re-armed on restart) and again at read time. Dedupe state is the one
 * thing that outlives a revocation or an expired rollup: it is what stops a re-signed replay from
 * being counted twice, and it lives until the accepted occurrence window has passed.
 */
export class TelemetryAggregateStore extends DurableObject<object> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#migrate();
    // A restart must not leave stored state without a purge alarm, and must not keep anything that
    // expired while the object was away.
    ctx.blockConcurrencyWhile(async () => {
      this.#purge(this.now());
      await this.#scheduleEarliest();
    });
  }

  /**
   * Creates the tables. A pre-W8a database (the receiver was never deployed or enrolled) is
   * migrated in place: dedupe state is untouched and gains a bucket-end column; rollups written
   * without trusted dimensions move to `rollups_legacy`, which keeps their counts but no zone,
   * calendar or revision (none is invented), is never read as dimensioned, and expires with the
   * policy like any rollup (and at a hard ten-year ceiling otherwise).
   */
  #migrate(): void {
    const tableSql = (name: string) =>
      this.#sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()[0]?.sql ?? null;
    this.ctx.storage.transactionSync(() => {
      if (tableSql("rollups")?.includes("config_revision") === false) {
        this.#sql.exec("ALTER TABLE rollups RENAME TO rollups_legacy");
        this.#sql.exec("ALTER TABLE rollups_legacy ADD COLUMN expires_at INTEGER");
        this.#sql.exec("UPDATE rollups_legacy SET expires_at = bucket_start + ?", BUCKET_MS + LEGACY_MAX_RETENTION_MS);
      }
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_key TEXT PRIMARY KEY,
          digest TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          bucket_end INTEGER
        );
        CREATE INDEX IF NOT EXISTS deliveries_expiry ON deliveries (expires_at);
        CREATE TABLE IF NOT EXISTS rollups_legacy (
          bucket_start INTEGER NOT NULL,
          source TEXT NOT NULL,
          grade_band TEXT NOT NULL,
          modality TEXT NOT NULL,
          producer_revision TEXT NOT NULL,
          evaluated INTEGER NOT NULL,
          candidate INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (bucket_start, source, grade_band, modality, producer_revision)
        );
        CREATE TABLE IF NOT EXISTS rollups (
          bucket_start INTEGER NOT NULL,
          source TEXT NOT NULL,
          grade_band TEXT NOT NULL,
          modality TEXT NOT NULL,
          producer_revision TEXT NOT NULL,
          config_revision TEXT NOT NULL,
          calendar_revision TEXT NOT NULL,
          time_zone TEXT NOT NULL,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL,
          weekday INTEGER NOT NULL,
          week_start TEXT NOT NULL,
          utc_offset_minutes INTEGER NOT NULL,
          calendar_kind TEXT NOT NULL,
          evaluated INTEGER NOT NULL,
          candidate INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          late_revisions INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (bucket_start, source, grade_band, modality, producer_revision, config_revision, calendar_revision)
        );
        CREATE TABLE IF NOT EXISTS ingest_health (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_ingest_at INTEGER,
          committed INTEGER NOT NULL,
          deduplicated INTEGER NOT NULL,
          conflicts INTEGER NOT NULL,
          expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS retention_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL,
          policy_revision TEXT NOT NULL,
          dedupe_ms INTEGER NOT NULL,
          rollup_ms INTEGER NOT NULL,
          health_ms INTEGER NOT NULL,
          revoked_floor INTEGER
        );
      `);
      if (tableSql("deliveries")?.includes("bucket_end") === false) {
        this.#sql.exec("ALTER TABLE deliveries ADD COLUMN bucket_end INTEGER");
      }
      if (tableSql("ingest_health")?.includes("expires_at") === false) {
        // Pre-W8a health had no retention policy, so none of it is kept.
        this.#sql.exec("ALTER TABLE ingest_health ADD COLUMN expires_at INTEGER");
        this.#sql.exec("UPDATE ingest_health SET last_ingest_at = NULL, committed = 0, deduplicated = 0, conflicts = 0");
      }
      this.#sql.exec("INSERT OR IGNORE INTO ingest_health (id, last_ingest_at, committed, deduplicated, conflicts, expires_at) VALUES (1, NULL, 0, 0, 0, NULL)");
    });
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

    // No approved retention in force at this object's clock: store nothing at all, not even health.
    const applied = toApplied(input.retention);
    if (!(applied.effectiveFromMs <= now && now < applied.approvedUntilMs)) return { kind: "retention" };
    const bucketStart = bucketStartOf(occurred);
    // An expired bucket is never recreated, and neither is one purged by a revocation.
    if (rollupExpiry(bucketStart, applied) <= now) return { kind: "stale" };
    const floor = this.#retention()?.revoked_floor ?? null;
    if (floor !== null && bucketStart < floor) return { kind: "stale" };
    this.#applyPolicy(applied, now);

    // Assigned inside the transaction callback; "capacity" is what remains if no branch ran.
    let outcome = { kind: "capacity" } as IngestOutcome;
    this.ctx.storage.transactionSync(() => {
      const existing = this.#sql.exec<{ digest: string }>("SELECT digest FROM deliveries WHERE delivery_key = ?", input.deliveryKey).toArray()[0];
      if (existing !== undefined) {
        if (existing.digest === input.digest) {
          this.#touchHealth(now, "deduplicated", applied);
          outcome = { kind: "deduplicated" };
        } else {
          this.#touchHealth(now, "conflicts", applied);
          outcome = { kind: "conflict" };
        }
        return;
      }
      const rows = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries").one().n;
      if (rows >= input.maxDedupeRows) return;
      const t = input.time;
      const keyArgs = [bucketStart, first.source, first.gradeBand, first.modality, input.producerRevision, t.configRevision, t.calendarRevision];
      // A revision id names one set of local dimensions. If the bucket already holds different ones
      // (a revision re-labelled with new content), counting into it would mix revisions: refuse.
      const prior = this.#sql
        .exec<{ time_zone: string; local_date: string; local_hour: number; weekday: number; week_start: string; utc_offset_minutes: number; calendar_kind: string }>(
          `SELECT time_zone, local_date, local_hour, weekday, week_start, utc_offset_minutes, calendar_kind FROM rollups
           WHERE bucket_start = ? AND source = ? AND grade_band = ? AND modality = ? AND producer_revision = ? AND config_revision = ? AND calendar_revision = ?`,
          ...keyArgs,
        )
        .toArray()[0];
      if (prior !== undefined && (prior.time_zone !== t.timeZone || prior.local_date !== t.localDate || prior.local_hour !== t.localHour ||
          prior.weekday !== t.weekday || prior.week_start !== t.weekStartingMonday ||
          prior.utc_offset_minutes !== t.utcOffsetMinutes || prior.calendar_kind !== t.calendarKind)) {
        outcome = { kind: "config_conflict" };
        return;
      }
      this.#sql.exec(
        "INSERT INTO deliveries (delivery_key, digest, expires_at, bucket_end) VALUES (?, ?, ?, ?)",
        input.deliveryKey,
        input.digest,
        dedupeExpiry(bucketStart, applied),
        bucketEnd(bucketStart),
      );
      // One row per bucket and dimension set carries the whole pair: evaluated is always +1, and
      // candidate is +1 only when the same delivery carried its matching candidate event. The same
      // statement advances the bucket's correction revision, so counters and revision cannot drift.
      this.#sql.exec(
        `INSERT INTO rollups (bucket_start, source, grade_band, modality, producer_revision, config_revision, calendar_revision,
                              time_zone, local_date, local_hour, weekday, week_start, utc_offset_minutes, calendar_kind,
                              evaluated, candidate, revision, late_revisions, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
         ON CONFLICT (bucket_start, source, grade_band, modality, producer_revision, config_revision, calendar_revision)
         DO UPDATE SET evaluated = evaluated + 1,
                       candidate = candidate + excluded.candidate,
                       revision = revision + 1,
                       late_revisions = late_revisions + excluded.late_revisions,
                       expires_at = MIN(expires_at, excluded.expires_at)`,
        ...keyArgs,
        t.timeZone,
        t.localDate,
        t.localHour,
        t.weekday,
        t.weekStartingMonday,
        t.utcOffsetMinutes,
        t.calendarKind,
        input.events.length === 2 ? 1 : 0,
        now >= bucketEnd(bucketStart) ? 1 : 0,
        rollupExpiry(bucketStart, applied),
      );
      this.#touchHealth(now, "committed", applied);
      this.afterIngestWrites();
      outcome = { kind: "committed" };
    });
    // Also after a refusal or duplicate: applying a shorter policy may have moved the next expiry.
    await this.#scheduleEarliest();
    return outcome;
  }

  /**
   * The exact chronological counters, oldest first. An internal read; no route exposes it yet.
   * Rows past their expiry are excluded here even before an alarm has deleted them.
   */
  async rollups(): Promise<readonly RollupRow[]> {
    const now = this.now();
    const rollupMs = this.#rollupMs();
    const live = `MIN(expires_at, bucket_start + ${BUCKET_MS} + ?) > ?`;
    const current = this.#sql
      .exec<RollupDbRow>(`SELECT * FROM rollups WHERE ${live}`, rollupMs, now)
      .toArray()
      .map((row): RollupRow => ({
        bucketStart: new Date(row.bucket_start).toISOString(),
        source: row.source,
        gradeBand: row.grade_band,
        modality: row.modality,
        producerRevision: row.producer_revision,
        evaluated: row.evaluated,
        candidate: row.candidate,
        time: {
          configRevision: row.config_revision, calendarRevision: row.calendar_revision, timeZone: row.time_zone,
          localDate: row.local_date, localHour: row.local_hour, weekday: row.weekday,
          weekStartingMonday: row.week_start, utcOffsetMinutes: row.utc_offset_minutes, calendarKind: row.calendar_kind,
        },
        revision: row.revision,
        lateRevisions: row.late_revisions,
        provisional: bucketProvisional(row.bucket_start, now),
        completeness: "unavailable",
      }));
    const legacy = this.#sql
      .exec<LegacyDbRow>(`SELECT * FROM rollups_legacy WHERE ${live}`, rollupMs, now)
      .toArray()
      .map((row): RollupRow => ({
        bucketStart: new Date(row.bucket_start).toISOString(),
        source: row.source,
        gradeBand: row.grade_band,
        modality: row.modality,
        producerRevision: row.producer_revision,
        evaluated: row.evaluated,
        candidate: row.candidate,
        time: null,
        revision: null,
        lateRevisions: null,
        provisional: null,
        completeness: "unavailable",
      }));
    return [...current, ...legacy].sort((a, b) =>
      a.bucketStart.localeCompare(b.bucketStart) || a.source.localeCompare(b.source) ||
      a.gradeBand.localeCompare(b.gradeBand) || a.modality.localeCompare(b.modality) ||
      a.producerRevision.localeCompare(b.producerRevision) ||
      (a.time?.configRevision ?? "").localeCompare(b.time?.configRevision ?? ""));
  }

  async health(): Promise<IngestHealth> {
    const now = this.now();
    const row = this.#sql
      .exec<{ last_ingest_at: number | null; committed: number; deduplicated: number; conflicts: number; expires_at: number | null }>("SELECT * FROM ingest_health WHERE id = 1")
      .one();
    const live = row.expires_at !== null && row.expires_at > now;
    const dedupeRows = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE expires_at > ?", now).one().n;
    return {
      lastIngestAt: live && row.last_ingest_at !== null ? new Date(row.last_ingest_at).toISOString() : null,
      committed: live ? row.committed : 0,
      deduplicated: live ? row.deduplicated : 0,
      conflicts: live ? row.conflicts : 0,
      dedupeRows,
      producerCoverage: "unavailable",
    };
  }

  /** The persisted policy state, or null before any policy was applied. */
  async retention(): Promise<RetentionState | null> {
    const row = this.#retention();
    return row === null ? null : {
      state: row.state,
      policyRevision: row.policy_revision,
      revokedFloor: row.revoked_floor === null ? null : new Date(row.revoked_floor).toISOString(),
    };
  }

  /**
   * An authorized revocation: deletes the tenant's rollups and health now, and refuses any
   * occurrence in a bucket the purge touched or that starts before the revocation (a bounded
   * tombstone), so re-enrolling cannot rebuild purged totals. The boundary is the later of the
   * revocation time rounded up to a bucket and the end of the newest purged bucket: an occurrence
   * is accepted up to the future-skew allowance ahead of the clock, so a purged bucket can start
   * after the revocation time itself. Dedupe digests are deliberately KEPT until their normal
   * horizon expiry, so a held delivery cannot be recounted either; and because its bucket is below
   * the boundary it is refused, never acknowledged as durably counted when its totals are gone. The
   * tombstone itself ages out once the accepted occurrence window has passed. Only the Worker calls
   * this, after authenticating the tenant and finding its server-owned configuration revoked.
   */
  async revoke(): Promise<void> {
    const now = this.now();
    this.ctx.storage.transactionSync(() => {
      // Read before the delete: the held deliveries and the totals being purged both name buckets.
      const newest = (query: string) => this.#sql.exec<{ end: number | null }>(query).one().end ?? 0;
      const purgedUpTo = Math.max(
        newest("SELECT MAX(bucket_end) AS end FROM deliveries"),
        newest(`SELECT MAX(bucket_start) + ${BUCKET_MS} AS end FROM rollups`),
        newest(`SELECT MAX(bucket_start) + ${BUCKET_MS} AS end FROM rollups_legacy`),
      );
      this.#sql.exec("DELETE FROM rollups");
      this.#sql.exec("DELETE FROM rollups_legacy");
      this.#resetHealth();
      this.#sql.exec(
        `INSERT INTO retention_state (id, state, policy_revision, dedupe_ms, rollup_ms, health_ms, revoked_floor)
         VALUES (1, 'revoked', 'revoked', 0, 0, 0, ?)
         ON CONFLICT (id) DO UPDATE SET state = 'revoked', policy_revision = 'revoked', dedupe_ms = 0, rollup_ms = 0, health_ms = 0,
                                        revoked_floor = MAX(COALESCE(revoked_floor, 0), excluded.revoked_floor)`,
        Math.max(ceilToBucket(now), purgedUpTo),
      );
    });
    await this.#scheduleEarliest();
  }

  /** Purges everything past its expiry, then re-arms for the next one. */
  override async alarm(): Promise<void> {
    this.#purge(this.now());
    const next = this.#nextExpiry();
    if (next !== null) await this.armAlarm(this.#alarmAt(next));
  }

  /** The object's clock: the trusted ingress time. A seam so tests can age the object. */
  protected now(): number {
    return Date.now();
  }

  /** Runs inside the ingest transaction after every write; a seam for injecting a commit failure. */
  protected afterIngestWrites(): void {}

  /** Arms the runtime alarm (a real timestamp). A seam so a test that ages this object's clock can drive alarms by hand. */
  protected async armAlarm(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
  }

  #retention(): RetentionRow | null {
    return this.#sql.exec<RetentionRow>("SELECT * FROM retention_state WHERE id = 1").toArray()[0] ?? null;
  }

  /** The rollup TTL of the policy now in force. Absent a policy, only stored expiries apply. */
  #rollupMs(): number {
    return this.#retention()?.rollup_ms ?? NO_LIMIT;
  }

  /**
   * Applies the policy in force. A change takes effect immediately and only ever tightens stored
   * expiries (rows keep the smaller of what they were given and what the new policy allows), so
   * lengthening a policy cannot revive or prolong data and shortening it deletes what it no longer
   * permits. Dedupe expiry never drops below the accepted-horizon floor.
   */
  #applyPolicy(applied: AppliedRetention, now: number): void {
    const row = this.#retention();
    if (row !== null && row.state === "active" && row.policy_revision === applied.policyRevision &&
        row.dedupe_ms === applied.dedupeMs && row.rollup_ms === applied.rollupMs && row.health_ms === applied.healthMs) return;
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT INTO retention_state (id, state, policy_revision, dedupe_ms, rollup_ms, health_ms)
         VALUES (1, 'active', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = 'active', policy_revision = excluded.policy_revision,
           dedupe_ms = excluded.dedupe_ms, rollup_ms = excluded.rollup_ms, health_ms = excluded.health_ms`,
        applied.policyRevision, applied.dedupeMs, applied.rollupMs, applied.healthMs,
      );
      this.#sql.exec(
        "UPDATE deliveries SET expires_at = MIN(expires_at, bucket_end + ?) WHERE bucket_end IS NOT NULL",
        Math.max(applied.dedupeMs, DEDUPE_RETENTION_AFTER_OCCURRENCE_MS),
      );
      this.#sql.exec(
        `UPDATE ingest_health SET expires_at = MIN(expires_at, ((last_ingest_at + ? + ${BUCKET_MS - 1}) / ${BUCKET_MS}) * ${BUCKET_MS})
         WHERE expires_at IS NOT NULL AND last_ingest_at IS NOT NULL`,
        applied.healthMs,
      );
      // Rollups too, current and pre-W8a alike, and persistently: the read and purge filters apply the
      // policy in force at that moment, so a later, longer policy would otherwise bring back a
      // deadline the shorter one already ended. A pre-W8a row may have no stored deadline at all.
      for (const table of ["rollups", "rollups_legacy"]) {
        this.#sql.exec(
          `UPDATE ${table} SET expires_at = MIN(COALESCE(expires_at, bucket_start + ${BUCKET_MS} + ?), bucket_start + ${BUCKET_MS} + ?)`,
          applied.rollupMs,
          applied.rollupMs,
        );
      }
      this.#purge(now);
    });
  }

  #resetHealth(): void {
    this.#sql.exec("UPDATE ingest_health SET last_ingest_at = NULL, committed = 0, deduplicated = 0, conflicts = 0, expires_at = NULL WHERE id = 1");
  }

  #touchHealth(now: number, counter: "committed" | "deduplicated" | "conflicts", applied: AppliedRetention): void {
    // Health that has expired is dropped before it is counted into, so a new window starts clean.
    this.#sql.exec("UPDATE ingest_health SET last_ingest_at = NULL, committed = 0, deduplicated = 0, conflicts = 0, expires_at = NULL WHERE id = 1 AND (expires_at IS NULL OR expires_at <= ?)", now);
    this.#sql.exec(
      `UPDATE ingest_health SET last_ingest_at = ?, ${counter} = ${counter} + 1, expires_at = ? WHERE id = 1`,
      now,
      healthExpiry(now, applied),
    );
  }

  /** Deletes dedupe, rollup, health and tombstone state that is past its expiry under the policy now in force. */
  #purge(now: number): void {
    const rollupMs = this.#rollupMs();
    this.#sql.exec("DELETE FROM deliveries WHERE expires_at <= ?", now);
    for (const table of ["rollups", "rollups_legacy"]) {
      this.#sql.exec(`DELETE FROM ${table} WHERE MIN(expires_at, bucket_start + ${BUCKET_MS} + ?) <= ?`, rollupMs, now);
    }
    this.#sql.exec("UPDATE ingest_health SET last_ingest_at = NULL, committed = 0, deduplicated = 0, conflicts = 0, expires_at = NULL WHERE id = 1 AND expires_at IS NOT NULL AND expires_at <= ?", now);
    // Once the accepted occurrence window has passed the floor, nothing it guards can arrive.
    this.#sql.exec("UPDATE retention_state SET revoked_floor = NULL WHERE revoked_floor IS NOT NULL AND revoked_floor + ? <= ?", DEDUPE_RETENTION_AFTER_OCCURRENCE_MS, now);
  }

  /** The earliest time anything stored here expires, or null when nothing is stored. */
  #nextExpiry(): number | null {
    const rollupMs = this.#rollupMs();
    const one = (query: string, ...args: number[]) => this.#sql.exec<{ next: number | null }>(query, ...args).one().next;
    const candidates = [
      one("SELECT MIN(expires_at) AS next FROM deliveries"),
      one(`SELECT MIN(MIN(expires_at, bucket_start + ${BUCKET_MS} + ?)) AS next FROM rollups`, rollupMs),
      one(`SELECT MIN(MIN(expires_at, bucket_start + ${BUCKET_MS} + ?)) AS next FROM rollups_legacy`, rollupMs),
      one("SELECT MIN(expires_at) AS next FROM ingest_health WHERE expires_at IS NOT NULL"),
      one("SELECT MIN(revoked_floor) + ? AS next FROM retention_state WHERE revoked_floor IS NOT NULL", DEDUPE_RETENTION_AFTER_OCCURRENCE_MS),
    ].filter((value): value is number => value !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  async #scheduleEarliest(): Promise<void> {
    const next = this.#nextExpiry();
    if (next === null) return;
    const at = this.#alarmAt(next);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.armAlarm(at);
  }

  /**
   * Alarms are armed against the runtime clock as a delay from THIS object's clock. In production the
   * two clocks are the same, so this is simply the expiry; it keeps a test that ages the object
   * from scheduling an alarm that is already due by the real clock.
   */
  #alarmAt(expiry: number): number {
    return Date.now() + Math.max(0, expiry - this.now());
  }
}
