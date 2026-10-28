// Shared harness for the W8a receiver tests: real route, real Durable Object, test clock seam.
// Everything here is synthetic. Nothing ships.
import { env, runInDurableObject } from "cloudflare:test";
import { buildTelemetryDeliveryV2, newDeliveryId, type TemporalMetricEvent } from "@gmacko/hall-monitor-telemetry-contracts";
import { sendDeliveryV2, signedDeliveryRequestV2, type TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";
import { handleTelemetry, type TelemetryEnv } from "../src/index.ts";
import { controls } from "./controls.ts";
import { configDoc, intervalDoc, policyDoc } from "./fixtures.ts";

export const KEY = "synthetic-receiver-educateos-key-0123456789-abc";
export const OTHER_KEY = "synthetic-receiver-playtrek-key-0123456789-abcd";
export const TENANT = "tenant_educateos";
export const OTHER = "tenant_playtrek";
export const GRANTS = JSON.stringify({
  [TENANT]: { source: "educateos", gradeBands: ["g9_12"], signingKey: KEY, producerRevisions: ["rev-a", "rev-b"] },
  [OTHER]: { source: "playtrek", gradeBands: ["g9_12", "adult"], signingKey: OTHER_KEY, producerRevisions: ["rev-a"] },
});

/** A policy that is in force across every absolute date these tests use (and is fictional). */
export const FIXED_POLICY = policyDoc(0, { effectiveFrom: "2026-01-01T00:00:00Z", approvedUntil: "2030-01-01T00:00:00Z" });
/** One interval covering all of the absolute 2026 dates these tests use. */
export const fixedInterval = (over: Record<string, unknown> = {}) =>
  intervalDoc({ from: "2026-01-01T00:00:00Z", to: "2027-03-01T00:00:00Z", ...over });

/** The two-tenant configuration setting with absolute dates, overridable per tenant. */
export function fixedConfig(edu: Record<string, unknown> = {}, playtrek: Record<string, unknown> | null = {}): string {
  return JSON.stringify({
    [TENANT]: configDoc({ retention: FIXED_POLICY, intervals: [fixedInterval()], ...edu }),
    ...(playtrek === null ? {} : {
      [OTHER]: configDoc({
        configRevision: "cfg-pt-1", source: "playtrek", retention: FIXED_POLICY,
        intervals: [fixedInterval({ producerRevisions: ["rev-a"] })], ...playtrek,
      }),
    }),
  });
}

export const at = (iso: string) => { controls.clockOffsetMs = Date.parse(iso) - Date.now(); };

export function evaluated(occurredAt: string, over: Partial<TemporalMetricEvent> = {}): TemporalMetricEvent {
  return {
    schemaVersion: 1, occurredAt, kind: "content_evaluated", category: "none", priority: "routine",
    modality: "text", gradeBand: "g9_12", source: "educateos", calendarKind: "unknown", ...over,
  };
}
const candidateOf = (e: TemporalMetricEvent): TemporalMetricEvent => ({ ...e, kind: "candidate_flagged", category: "other" });

export async function delivery(occurredAt: string, over: { id?: string; revision?: string; pair?: boolean; event?: Partial<TemporalMetricEvent> } = {}) {
  const first = evaluated(occurredAt, over.event);
  return buildTelemetryDeliveryV2({
    deliveryId: over.id ?? newDeliveryId(),
    producerRevision: over.revision ?? "rev-a",
    events: over.pair ? [first, candidateOf(first)] : [first],
  });
}

export type Built = Awaited<ReturnType<typeof delivery>>;

export function receiverEnv(config: string, extra: Partial<TelemetryEnv> = {}): TelemetryEnv {
  return { ...env, HM_TELEMETRY_V2_ACCEPT: "aggregate", HM_TELEMETRY_V2_TENANTS: GRANTS, HM_TELEMETRY_V2_CONFIG: config, ...extra } as TelemetryEnv;
}
const binding = (e: TelemetryEnv): TelemetryBinding => ({ fetch: (request) => handleTelemetry(request, e) });

export const send = (b: Built, e: TelemetryEnv, tenant = TENANT, key = KEY) => sendDeliveryV2(binding(e), tenant, key, b.payload, b.digest);
export const post = async (b: Built, e: TelemetryEnv, tenant = TENANT, key = KEY) =>
  handleTelemetry(await signedDeliveryRequestV2(tenant, key, b.payload, b.digest), e);

export const stub = (tenant = TENANT) => env.AGGREGATES!.get(env.AGGREGATES!.idFromName(`tenant:${tenant}`));
export const sql = <T>(query: string, tenant = TENANT) =>
  runInDurableObject(stub(tenant), (_i, state) => state.storage.sql.exec(query).toArray() as T[]);
export const count = async (table: string, tenant = TENANT) => (await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`, tenant))[0]!.n;

export async function totals(tenant = TENANT) {
  const rows = await stub(tenant).rollups();
  return { evaluated: rows.reduce((n, r) => n + r.evaluated, 0), candidate: rows.reduce((n, r) => n + r.candidate, 0), rows: rows.length };
}

/** Nothing of any kind was stored by a refused request (no counters, dedupe, health or policy). */
export async function expectNothingStored(tenant = TENANT): Promise<void> {
  const { expect } = await import("vitest");
  expect(await totals(tenant)).toEqual({ evaluated: 0, candidate: 0, rows: 0 });
  expect(await count("deliveries", tenant)).toBe(0);
  expect(await count("rollups", tenant)).toBe(0);
  expect(await count("retention_state", tenant)).toBe(0);
  expect(await stub(tenant).health()).toMatchObject({ lastIngestAt: null, committed: 0, deduplicated: 0, conflicts: 0, dedupeRows: 0 });
}

/** Signs arbitrary payload bytes under the v2 domain, as a compromised-but-keyed sender could. */
export async function forged(payload: string, tenant = TENANT, key = KEY): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(`hall-monitor-telemetry-v2\n${tenant}\n${ts}\n${payload}`),
  );
  return new Request("https://telemetry.internal/internal/v2/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-hm-telemetry-tenant": tenant, "x-hm-telemetry-time": String(ts),
      "x-hm-telemetry-signature": [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    },
    body: payload,
  });
}
