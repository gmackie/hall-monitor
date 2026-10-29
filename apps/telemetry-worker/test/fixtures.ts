// Synthetic tenant configuration for tests. Every value here is FICTIONAL: the approval reference is
// not an approval, the durations are not a recommended or approved retention, and no real district,
// zone choice or calendar is implied. Nothing here ships.
import type { TelemetryRetentionPolicy } from "@gmacko/hall-monitor-telemetry-contracts";
import { BUCKET_MS } from "../src/time.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const floorBucket = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

/** A fictional, internally consistent policy document (as it appears in the server setting). */
export function policyDoc(now = Date.now(), over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyRevision: "synthetic-policy-1",
    approvalRef: "SYNTHETIC-TEST-ONLY-NOT-AN-APPROVAL",
    effectiveFrom: iso(floorBucket(now - 30 * DAY_MS)),
    approvedUntil: iso(floorBucket(now + 400 * DAY_MS)),
    dedupeSeconds: 86_700, // the smallest value the schema accepts: the accepted horizon, 24 h + 5 min
    rollupSeconds: 30 * 86_400,
    healthSeconds: 3_600,
    gapSeconds: 30 * 86_400,
    ...over,
  };
}

export function parsedPolicy(over: Record<string, unknown> = {}, now = Date.now()): TelemetryRetentionPolicy {
  const doc = policyDoc(now, over);
  return {
    policyRevision: doc.policyRevision as string,
    approvalRef: doc.approvalRef as string,
    effectiveFromMs: Date.parse(doc.effectiveFrom as string),
    approvedUntilMs: Date.parse(doc.approvedUntil as string),
    dedupeSeconds: doc.dedupeSeconds as number,
    rollupSeconds: doc.rollupSeconds as number,
    healthSeconds: doc.healthSeconds as number,
    gapSeconds: doc.gapSeconds as number,
  };
}

export interface IntervalDoc extends Record<string, unknown> {
  from: string;
  to: string;
  timeZone: string;
  calendarRevision: string;
  producerRevisions: string[];
  calendar: { from: string; to: string; kind: string }[];
}

export function intervalDoc(over: Partial<IntervalDoc> = {}, now = Date.now()): IntervalDoc {
  const from = floorBucket(now - 90 * DAY_MS);
  return {
    from: iso(from), to: iso(from + 500 * DAY_MS), timeZone: "America/Detroit",
    calendarRevision: "cal-a", producerRevisions: ["rev-a", "rev-b"], calendar: [], ...over,
  };
}

export function configDoc(over: Record<string, unknown> = {}, now = Date.now()): Record<string, unknown> {
  return {
    schemaVersion: 1, configRevision: "cfg-edu-1", source: "educateos", state: "active",
    retention: policyDoc(now), intervals: [intervalDoc({}, now)], ...over,
  };
}

/** The two-tenant setting the receiver tests use, as JSON. */
export function configJson(
  edu: Record<string, unknown> = {},
  playtrek: Record<string, unknown> | null = {},
  now = Date.now(),
): string {
  return JSON.stringify({
    tenant_educateos: configDoc(edu, now),
    ...(playtrek === null ? {} : {
      tenant_playtrek: configDoc({
        configRevision: "cfg-pt-1", source: "playtrek",
        intervals: [intervalDoc({ producerRevisions: ["rev-a"] }, now)], ...playtrek,
      }, now),
    }),
  });
}
