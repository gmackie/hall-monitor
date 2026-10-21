// The rollback drill (docs/launch/rollback-drill.md), run against the real Worker in the workerd
// test harness so it needs no deployment. `pnpm rollback-drill` runs this file alone and records
// the outcome; `pnpm test` runs it with everything else. Synthetic data only.
import { env, runInDurableObject } from "cloudflare:test";
import { type EvaluationRequest, EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { BUILTIN_CASES, diffDecisions, overlayVariant, selectCases } from "@gmacko/hall-monitor-shadow-report";
import { type FixtureCase, fixtureRequest } from "@gmacko/hall-monitor-test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import type { IdempotencyStore } from "../src/store.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, direct } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const TENANT = "tenant_drill";

/** Policy revision 1 of the drill tenant: the 9-12 floor, republished under its own revision. */
const REVISION_1 = { [TENANT]: { "student-9-12": { revision: "drill:1" } } };
/** Revision 2 tightens answer assistance to scaffolded, which changes graded-ness handling. */
const REVISION_2 = { [TENANT]: { "student-9-12": { revision: "drill:2", answerAssistance: "scaffolded" } } };

/** The drill corpus: every synthetic 9-12 student case. */
const DRILL_CASES = selectCases(BUILTIN_CASES, ["student-9-12"]);

let phase = 0;

/** A fixture as a drill-tenant request pinned to `revision`, with a key unique to this phase. */
function drillRequest(fixture: FixtureCase, revision: string): EvaluationRequest {
  const request = fixtureRequest(fixture);
  return {
    ...request,
    idempotencyKey: `drill_${phase}_${fixture.id}`,
    source: { product: "schoolos", tenantId: TENANT, surface: "drill" },
    policy: { profileId: "student-9-12", revision },
  };
}

/** Evaluates `request` against the Worker deployed with `overlays` (and the fake AI unless `ai` is false). */
async function evaluateUnder(overlays: unknown, request: EvaluationRequest, options: { ai?: boolean; env?: Partial<Env> } = {}) {
  const token = await mintToken("schoolos", { tenant: TENANT });
  const deployed: Partial<Env> = { HM_POLICY_OVERLAYS: JSON.stringify(overlays), ...options.env, ...(options.ai === false ? {} : { AI: fakeAi }) };
  return direct("/v1/evaluations", call("POST", token, request), deployed);
}

async function decisionsUnder(overlays: unknown, revision: string): Promise<Map<string, string>> {
  phase++;
  const decisions = new Map<string, string>();
  for (const fixture of DRILL_CASES.cases) {
    const response = await evaluateUnder(overlays, drillRequest(fixture, revision));
    expect(response.status, fixture.id).toBe(200);
    decisions.set(fixture.id, EvaluationResult.parse(await response.json()).decision);
  }
  return decisions;
}

beforeEach(() => {
  fakeAi.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("rollback drill", () => {
  it("drill 1: an unavailable classifier holds student traffic (fail closed), even for a shadow tenant", async () => {
    const fixture = DRILL_CASES.cases.find((candidate) => candidate.id === "benign-02")!;
    phase++;
    fakeAi.failing = true;
    const outage = EvaluationResult.parse(await (await evaluateUnder(REVISION_1, drillRequest(fixture, "drill:1"))).json());
    expect(outage).toMatchObject({ decision: "hold", uncertain: true, degraded: { reason: "classifier_unavailable" } });
    expect(outage.reasonCodes).toContain("hall_monitor.unavailable");
    expect(outage.receipt?.hasUnknownCost).toBe(true);

    // With no AI binding at all, and with the tenant in shadow mode, students are still held.
    phase++;
    const shadowTenant = { HM_TENANT_MODES: JSON.stringify({ [TENANT]: "shadow" }) };
    const unbound = await evaluateUnder(REVISION_1, drillRequest(fixture, "drill:1"), { ai: false, env: shadowTenant });
    const held = EvaluationResult.parse(await unbound.json());
    expect(held).toMatchObject({ decision: "hold", degraded: { reason: "classifier_unavailable" }, receipt: null });
    expect(held.shadow).toBeUndefined();

    // Recovery: once the classifier answers again, the same content is allowed.
    fakeAi.failing = false;
    phase++;
    const recovered = EvaluationResult.parse(await (await evaluateUnder(REVISION_1, drillRequest(fixture, "drill:1"))).json());
    expect(recovered).toMatchObject({ decision: "allow", uncertain: false });
  });

  it("drill 2: pinning and rolling back a policy revision produces exactly the predicted decision diff", async () => {
    // The offline prediction: the shadow-report diff between the two revisions over the same corpus.
    const predicted = await diffDecisions(DRILL_CASES, overlayVariant("drill:1", REVISION_1[TENANT]), overlayVariant("drill:2", REVISION_2[TENANT]));
    expect(predicted.changes.map((change) => `${change.id}:${change.from}->${change.to}`)).toEqual(["integrity-02:allow->coach", "integrity-13:allow->coach"]);
    expect(predicted.errors).toEqual([]);

    // Revision 2 is live: only its revision can be pinned.
    const fixture = DRILL_CASES.cases[0]!;
    phase++;
    expect((await evaluateUnder(REVISION_2, drillRequest(fixture, "drill:1"))).status).toBe(404);
    expect((await evaluateUnder(REVISION_2, drillRequest(fixture, "builtin-1"))).status).toBe(404);
    const underRevision2 = await decisionsUnder(REVISION_2, "drill:2");

    // Roll back to revision 1: revision 2 can no longer be pinned, and revision 1 decides again.
    phase++;
    expect((await evaluateUnder(REVISION_1, drillRequest(fixture, "drill:2"))).status).toBe(404);
    const underRevision1 = await decisionsUnder(REVISION_1, "drill:1");

    const observed = [...underRevision1]
      .filter(([id, decision]) => underRevision2.get(id) !== decision)
      .map(([id, decision]) => ({ id, from: decision, to: underRevision2.get(id) }));
    expect(observed).toEqual(predicted.changes.map(({ id, from, to }) => ({ id, from, to })));
  });

  it("drill 3: an idempotent replay survives a Durable Object restart without re-evaluating or re-billing", async () => {
    phase++;
    const fixture = DRILL_CASES.cases.find((candidate) => candidate.id === "benign-02")!;
    const request = drillRequest(fixture, "drill:1");
    const first = await evaluateUnder(REVISION_1, request);
    expect(first.status).toBe(200);
    const body = await first.text();
    const result = EvaluationResult.parse(JSON.parse(body));
    expect(fakeAi.calls).toHaveLength(1);

    // Restart the tenant's store: the running instance is discarded, its storage is kept.
    const id = env.IDEMPOTENCY_STORE.idFromName(`tenant:${TENANT}`);
    await runInDurableObject(env.IDEMPOTENCY_STORE.get(id), (_instance: IdempotencyStore, state) => state.abort("rollback drill restart")).catch(() => {});

    const replay = await evaluateUnder(REVISION_1, structuredClone(request));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(body);
    expect(fakeAi.calls).toHaveLength(1);

    const token = await mintToken("schoolos", { tenant: TENANT });
    const receipt = await direct(`/v1/receipts/${result.evaluationId}`, call("GET", token));
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ evaluationId: result.evaluationId, receipt: result.receipt });
  });
});
