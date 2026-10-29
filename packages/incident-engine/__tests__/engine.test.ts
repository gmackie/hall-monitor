import { admitSafetyDelivery, deriveSafetyReference, safetyEventDigest, signSafetyDelivery, type SafetyEvent, type SafetyReference,
  type VerifiedSafetyEvent } from "@gmacko/hall-monitor-safety-events";
import { describe, expect, it } from "vitest";
import { createSyntheticCase, ingestSyntheticAssertion, summarizeSyntheticCase, type SyntheticCaseLedger } from "../src/index.ts";

const now = Date.parse("2026-10-29T12:00:00Z"), key = new Uint8Array(32).fill(19);
const scope = { tenantId: "synthetic_tenant", caseId: "synthetic_case" };
const ref = (kind: SafetyReference["kind"], id: string) => deriveSafetyReference(key, scope, kind, id);
async function base(recordId = "permission_1"): Promise<SafetyEvent> {
  return { schemaVersion: "1.0", mode: "synthetic", scope, producerId: "synthetic-source", recordId, version: 1, previousDigest: null,
    revisionKind: "initial", dependencies: [], occurredAt: new Date(now - 2000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), category: "observed",
    assertion: { kind: "permission.transition", actor: await ref("person", "actor"), target: await ref("person", "alex-1"),
      group: await ref("group", "required"), evidence: await ref("evidence", "tx-1"), purpose: "required-group-work",
      authority: { actorRole: "delegated-student-moderator", actorEnrollmentVerified: true, targetEnrollmentVerified: true, permissionVerified: true }, from: "member", to: "removed" } };
}
async function report(recordId = "report_1"): Promise<SafetyEvent> {
  return { ...await base(recordId), category: "reported", assertion: { kind: "report.allegation", reporter: await ref("person", "reporter"),
    subjects: [await ref("person", "alex-1")], evidence: await ref("evidence", "original-message"), evidenceGroup: await ref("evidence-group", "original"),
    independence: "source-verified", provenance: "source-message", speechAct: "supportive-report", concern: "harassment" } };
}
async function verified(event: SafetyEvent): Promise<VerifiedSafetyEvent> {
  const fact = await admitSafetyDelivery(await signSafetyDelivery(event, "test-key", key, now), { scope: event.scope, producerId: event.producerId,
    keyId: "test-key", key, categories: ["observed", "reported", "model"], validFrom: now - 60000, expiresAt: now + 120000, maxEventAgeMs: 60000, maxLifetimeMs: 120000, revoked: false }, now);
  if (fact === undefined) throw new Error("test fixture rejected"); return fact;
}
async function ledger(events: SafetyEvent[]): Promise<SyntheticCaseLedger> {
  let result = createSyntheticCase(scope); for (const e of events) result = ingestSyntheticAssertion(result, await verified(e)); return result;
}
async function next(previous: SafetyEvent, changes: Partial<SafetyEvent>): Promise<SafetyEvent> {
  return { ...previous, version: previous.version + 1, previousDigest: await safetyEventDigest(previous), revisionKind: "correction", ...changes };
}
const summary = (l: SyntheticCaseLedger, at = now) => {
  const s = summarizeSyntheticCase(l, at); if (!("records" in s)) throw new Error("unexpected terminal fixture"); return s;
};

describe("bounded causal case ledger", () => {
  it("requires in-process verified, matching scoped admissions", async () => {
    const initial = createSyntheticCase(scope), e = await base(), fact = await verified(e);
    expect(() => ingestSyntheticAssertion(initial, { ...fact } as VerifiedSafetyEvent)).toThrow("unverified");
    expect(() => ingestSyntheticAssertion(createSyntheticCase({ ...scope, tenantId: "other" }), fact)).toThrow("mismatched");
    const first = ingestSyntheticAssertion(initial, fact);
    expect(ingestSyntheticAssertion(first, await verified(e))).toBe(first);
  });

  it("converges under reversed delivery, duplicates and a restoration preceding its removal", async () => {
    const removal = await base(); if (removal.assertion.kind !== "permission.transition") throw new Error();
    const restoration = await next(removal, { revisionKind: "transition", occurredAt: new Date(now - 1000).toISOString(),
      assertion: { ...removal.assertion, from: "removed", to: "member" } });
    expect(summary(await ledger([restoration])).status).toBe("incomplete");
    const a = summary(await ledger([removal, restoration, removal])), b = summary(await ledger([restoration, removal, restoration]));
    expect(a).toEqual(b); expect(a.status).toBe("ready"); expect(a.hypotheses).toEqual([]);
    expect(a.records[0]!.current!.event.version).toBe(2);
  });

  it("preserves conflicting histories, invalid chains and parallel permission records as incomplete", async () => {
    const original = await base(); if (original.assertion.kind !== "permission.transition") throw new Error();
    const conflict = { ...original, assertion: { ...original.assertion, purpose: "optional-social" as const } };
    expect(summary(await ledger([original, conflict])).records[0]!.status).toBe("conflict");
    const wrongDigest = await next(original, { previousDigest: `sha256:${"f".repeat(64)}` });
    expect(summary(await ledger([original, wrongDigest])).records[0]!.status).toBe("invalid");
    const invalidTransition = await next(original, { revisionKind: "transition" });
    expect(summary(await ledger([original, invalidTransition])).records[0]!.status).toBe("invalid");
    const parallel = summary(await ledger([original, { ...original, recordId: "other-history" }]));
    expect(parallel.status).toBe("incomplete"); expect(parallel.hypotheses).toEqual([]);
  });

  it("removes wrongly attributed claims and their dependents after correction or retraction", async () => {
    const original = await report(), digest = await safetyEventDigest(original);
    const model: SafetyEvent = { ...await base("model_1"), category: "model", dependencies: [{ recordId: original.recordId, digest }],
      assertion: { kind: "model.assertion", evidence: await ref("evidence", "original-message"), modelId: "simulated-model", modelRevision: "simulated-1",
        calibrationRevision: "not-approved", subjects: [await ref("person", "alex-1")], concern: "harassment", confidence: 0.99 } };
    expect(summary(await ledger([original, model])).hypotheses).toHaveLength(2);
    const retracted = await next(original, { revisionKind: "retraction", assertion: { kind: "record.retracted", reason: "wrong-attribution" } });
    const result = summary(await ledger([model, retracted, original]));
    expect(result.records.map((r) => r.status).sort()).toEqual(["dependency-unavailable", "retracted"]);
    expect(result.hypotheses).toEqual([]); expect(result.reportCount).toBe(0);
    if (original.assertion.kind !== "report.allegation") throw new Error();
    const corrected = await next(original, { assertion: { ...original.assertion, subjects: [await ref("person", "alex-2")] } });
    const correction = summary(await ledger([original, model, corrected]));
    expect(correction.records.find((r) => r.recordId === "report_1")!.current!.event.assertion).toMatchObject({ subjects: [await ref("person", "alex-2")] });
    expect(correction.records.find((r) => r.recordId === "model_1")!.status).toBe("dependency-unavailable");
  });

  it("keeps ambiguous subjects separate without resolving names or model confidence into identity", async () => {
    const a = await report(); if (a.assertion.kind !== "report.allegation") throw new Error();
    a.assertion.subjects.push(await ref("person", "alex-2"));
    const result = summary(await ledger([a]));
    expect(result.unresolvedReports).toBe(1); expect(result.hypotheses[0]!.reason).toBe("attribution-unresolved");
    expect(result.disclosure).toBe("unavailable"); expect(result.discipline).toBe("unavailable");
  });

  it("never turns ten forwarded or copied reports into independent witnesses or penalizes reporting", async () => {
    const reports: SafetyEvent[] = [];
    for (let n = 0; n < 10; n++) {
      const e = await report(`report_${n}`); if (e.assertion.kind !== "report.allegation") throw new Error();
      if (n > 0) { e.assertion.evidenceGroup = await ref("evidence-group", `falsely-distinct-${n}`); e.assertion.provenance = "copied-report"; }
      reports.push(e);
    }
    const result = summary(await ledger(reports));
    expect(result.reportCount).toBe(10); expect(result.sourceAttestedIndependentGroups).toBe(1);
    expect(result.hypotheses.every((h) => h.reason === "reported-concern-review")).toBe(true);
    const duplicateEvidence = await report("report_new_group");
    if (duplicateEvidence.assertion.kind !== "report.allegation") throw new Error();
    duplicateEvidence.assertion.evidenceGroup = await ref("evidence-group", "different-group");
    expect(summary(await ledger([reports[0]!, duplicateEvidence])).sourceAttestedIndependentGroups).toBe(1);
    duplicateEvidence.assertion.provenance = "unverified-capture";
    expect(summary(await ledger([duplicateEvidence])).sourceAttestedIndependentGroups).toBe(0);
  });

  it("does not turn optional participation, rumor forwarding or quotation into a source-observed offense", async () => {
    const optional = await base(); if (optional.assertion.kind !== "permission.transition") throw new Error(); optional.assertion.purpose = "optional-social";
    expect(summary(await ledger([optional])).hypotheses).toEqual([]);
    for (const speechAct of ["forwarded-rumor", "quoted-material"] as const) {
      const e = await report(); if (e.assertion.kind !== "report.allegation") throw new Error(); e.assertion.speechAct = speechAct;
      const result = summary(await ledger([e]));
      expect(result.sourceAttestedIndependentGroups).toBe(0); expect(result.reportCount).toBe(1);
      expect(result.hypotheses[0]!.reason).toBe("reported-concern-review");
    }
  });

  it("expires hypotheses without resurrecting superseded claims, and refuses backwards read clocks", async () => {
    const original = await report(), corrected = await next(original, { expiresAt: new Date(now + 1).toISOString() });
    const l = await ledger([original, corrected]), expired = summary(l, now + 1);
    expect(expired.records[0]!.status).toBe("expired"); expect(expired.hypotheses).toEqual([]);
    expect(summarizeSyntheticCase(l, now - 1)).toMatchObject({ status: "clock-invalid" });
    const retract = await next(original, { revisionKind: "retraction", assertion: { kind: "record.retracted", reason: "withdrawn" } });
    const resurrect = await next(retract, { assertion: original.assertion });
    expect(summary(await ledger([original, retract, resurrect])).records[0]!.status).toBe("invalid");
  });

  it("retains duplicate identity at the fact limit and enters terminal capacity on new evidence", async () => {
    let l = createSyntheticCase(scope), first: VerifiedSafetyEvent | undefined;
    const original = await base();
    for (let n = 0; n < 256; n++) { const f = await verified({ ...original, recordId: `record_${n}` }); first ??= f; l = ingestSyntheticAssertion(l, f); }
    expect(ingestSyntheticAssertion(l, first!)).toBe(l);
    l = ingestSyntheticAssertion(l, await verified({ ...original, recordId: "overflow" }));
    expect(summarizeSyntheticCase(l, now)).toEqual({ mode: "synthetic", status: "capacity", activation: "not-approved" });
    expect(ingestSyntheticAssertion(l, first!)).toBe(l);
  });
});
