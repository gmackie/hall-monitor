import type { EvaluationPage, EvaluationQuery, EvaluationRecord } from "@gmacko/hall-monitor-contracts";
import type { EvaluatorRpc } from "../src/env.ts";

/** An in-memory stand-in for the evaluation Worker's AdminRpc, tenant-scoped like the real one. */
const records = new Map<string, EvaluationRecord[]>();
const calls: { method: string; tenant: string }[] = [];

export const fakeEvaluator = {
  records,
  calls,
  reset() {
    records.clear();
    calls.length = 0;
  },
  add(record: EvaluationRecord) {
    records.set(record.tenantId, [...(records.get(record.tenantId) ?? []), record]);
  },
  async listEvaluations(tenant: string, query: EvaluationQuery): Promise<EvaluationPage> {
    calls.push({ method: "list", tenant });
    if (query.cursor === "bad") throw new Error("invalid query");
    const items = (records.get(tenant) ?? []).filter((r) => query.decision === undefined || r.result.decision === query.decision);
    return { schemaVersion: "1.0", items: items.slice(0, query.limit ?? 50), nextCursor: null };
  },
  async getEvaluation(tenant: string, evaluationId: string): Promise<EvaluationRecord | null> {
    calls.push({ method: "get", tenant });
    return (records.get(tenant) ?? []).find((r) => r.evaluationId === evaluationId) ?? null;
  },
};
fakeEvaluator satisfies EvaluatorRpc;

/** A content-free synthetic record, optionally in shadow mode. */
export function record(tenant: string, evaluationId: string, shadow?: "hold" | "block"): EvaluationRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0", evaluationId, requestId: `req_${evaluationId}`, tenantId: tenant, product: "playtrek", surface: "voice_line.composed",
    evaluationKind: "content.candidate", contentType: "text", policy: { profileId: "student-6-8", revision: "builtin-1" },
    context: { audience: "student", costCenterId: "cc_test" }, mode: shadow === undefined ? "enforce" : "shadow",
    result: {
      schemaVersion: "1.0", evaluationId, requestId: `req_${evaluationId}`, decision: "allow",
      reasonCodes: shadow === undefined ? [] : ["hall_monitor.shadow"], findings: [],
      policy: { profileId: "student-6-8", revision: "builtin-1" }, evaluatorBundle: { id: "base", revision: "base-1.0.1" },
      ...(shadow === undefined ? {} : { shadow: { decision: shadow, reasonCodes: ["privacy.contact_info"] } }),
    } as unknown as EvaluationRecord["result"],
    recordedAt: now, expiresAt: now,
  };
}
