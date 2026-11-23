import { env } from "cloudflare:test";
import { CLEF_FLASH_MODEL, CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import { BASELINE_DECISION_PACK, BASELINE_DECISION_PACK_PIN } from "@gmacko/hall-monitor-noul-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, grant, ROOT } from "./helpers.ts";

const T = "playtrek";
const L1 = "labeler1@example.test";
const L2 = "labeler2@example.test";
const ADJ = "adjudicator@example.test";
const CASE_TEXT = "Fictional synthetic example";

function study(origin: Record<string, unknown> = { kind: "synthetic" }) {
  const cohort = { profileId: "student-9-12", profileRevision: "builtin-1", gradeBand: "9-12", language: "en", modality: "text", audience: "student", evaluationKind: "interaction.input" };
  return {
    schemaVersion: "1.0", revision: "study-1", corpusRevision: "corpus-1", pack: { ...BASELINE_DECISION_PACK_PIN },
    decisions: BASELINE_DECISION_PACK.definitions.map((d) => ({ id: d.id,
      textInstructions: d.questions.find((q) => q.modality === "text")!.instructions,
      imageInstructions: d.questions.find((q) => q.modality === "image")!.instructions })),
    cases: [0, 1].map((i) => ({ id: `source_${i}`, familyId: `family_${i}`, split: "held-out", origin, cohort: { ...cohort }, content: { type: "text", text: `${CASE_TEXT} ${i}.` } })),
    bands: BASELINE_DECISION_PACK.definitions.map((d) => ({ decisionId: d.id, cohort: { ...cohort }, providerId: CLOUDFLARE_WORKERS_AI, modelId: CLEF_FLASH_MODEL, band: { low: 0.35, high: 0.75 } })),
  };
}

type QueueItem = { blindId: string; decisions: { id: string }[]; content: { text: string } };

beforeEach(async () => {
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  for (const email of [L1, L2]) await grant(email, T, "labeler");
  await grant(ADJ, T, "adjudicator");
});

async function importSet(): Promise<string> {
  const response = await api(ROOT, "POST", `/tenants/${T}/label-sets`, { study: study() });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function labelAll(email: string, setId: string, label: (blind: string, decision: string) => string) {
  const queue = await (await api(email, "GET", `/tenants/${T}/label-sets/${setId}/queue`)).json() as { items: QueueItem[] };
  for (const item of queue.items) {
    const response = await api(email, "POST", `/tenants/${T}/label-sets/${setId}/items/${item.blindId}/labels`, { labels: item.decisions.map((d) => ({ decisionId: d.id, label: label(item.blindId, d.id) })) });
    expect(response.status).toBe(200);
  }
  return queue.items;
}

describe("label sets", () => {
  it("imports only synthetic or licensed studies, as admin", async () => {
    expect((await api(ROOT, "POST", `/tenants/${T}/label-sets`, { study: study({ kind: "production" }) })).status).toBe(400);
    expect((await api(L1, "POST", `/tenants/${T}/label-sets`, { study: study() })).status).toBe(403);
    expect((await api(ROOT, "POST", `/tenants/${T}/label-sets`, { study: study({ kind: "licensed", rightsRef: "lic-1" }) })).status).toBe(201);
  });

  it("serves a blinded queue: no key, split, source ids, other labels or model scores", async () => {
    const setId = await importSet();
    await labelAll(L1, setId, () => "negative");
    const response = await api(L2, "GET", `/tenants/${T}/label-sets/${setId}/queue`);
    const text = await response.text();
    const queue = JSON.parse(text) as { items: QueueItem[]; remaining: number };
    expect(queue.remaining).toBe(2);
    expect(queue.items[0]!.content.text).toContain(CASE_TEXT);
    for (const forbidden of ["source_", "family_", "held-out", "split", "key", "score", "negative", "band", L1]) expect(text).not.toContain(forbidden);
    // Fully labelled by L1: nothing left for them.
    expect((await (await api(L1, "GET", `/tenants/${T}/label-sets/${setId}/queue`)).json() as { remaining: number }).remaining).toBe(0);
    // Viewers cannot read case text.
    await grant("viewer@example.test", T, "viewer");
    expect((await api("viewer@example.test", "GET", `/tenants/${T}/label-sets/${setId}/queue`)).status).toBe(403);
  });

  it("keeps adjudicators independent of the reviewers of an item", async () => {
    const setId = await importSet();
    const items = await labelAll(L1, setId, () => "negative");
    await labelAll(L2, setId, (_b, d) => (d === items[0]!.decisions[0]!.id ? "positive" : "negative"));
    const queue = await (await api(ADJ, "GET", `/tenants/${T}/label-sets/${setId}/adjudication-queue`)).json() as { items: (QueueItem & { counts: Record<string, number> })[] };
    expect(queue.items.length).toBeGreaterThan(0);
    expect(queue.items[0]!.counts).toEqual({ negative: 1, positive: 1 });
    expect(JSON.stringify(queue)).not.toContain(L1);
    const target = queue.items[0]!;
    // A reviewer of the item may not adjudicate it, even holding the role.
    await grant(L1, T, "adjudicator");
    expect((await api(L1, "POST", `/tenants/${T}/label-sets/${setId}/items/${target.blindId}/adjudication`, { decisionId: target.decisions[0]!.id, label: "negative" })).status).toBe(409);
    expect((await api(ADJ, "POST", `/tenants/${T}/label-sets/${setId}/items/${target.blindId}/adjudication`, { decisionId: target.decisions[0]!.id, label: "negative" })).status).toBe(200);
    // ...and an adjudicator may not then label it.
    await grant(ADJ, T, "labeler");
    expect((await api(ADJ, "POST", `/tenants/${T}/label-sets/${setId}/items/${target.blindId}/labels`, { labels: [{ decisionId: target.decisions[0]!.id, label: "negative" }] })).status).toBe(409);
  });

  it("scores the set into a not-approved calibration report, with audit rows for every mutation", async () => {
    const setId = await importSet();
    const items = await labelAll(L1, setId, () => "negative");
    await labelAll(L2, setId, () => "negative");
    expect((await api(ADJ, "POST", `/tenants/${T}/label-sets/${setId}:score`)).status).toBe(409);
    const predictions = items.flatMap((item) => item.decisions.map((d) => ({ blindId: item.blindId, decisionId: d.id, score: 0.1 })));
    expect((await api(ADJ, "POST", `/tenants/${T}/label-sets/${setId}/predictions`, { run: { revision: "run-1", basis: "simulated", providerId: CLOUDFLARE_WORKERS_AI, modelId: CLEF_FLASH_MODEL }, predictions })).status).toBe(200);
    const scored = await api(ADJ, "POST", `/tenants/${T}/label-sets/${setId}:score`);
    expect(scored.status).toBe(201);
    const { report } = await scored.json() as { report: { activation: string; metrics: { trueNegatives: number }[] } };
    expect(report.activation).toBe("not-approved");
    expect(report.metrics.some((m) => m.trueNegatives === 2)).toBe(true);
    expect((await (await api(ADJ, "GET", `/tenants/${T}/label-sets/${setId}/calibration-reports`)).json() as { reports: unknown[] }).reports).toHaveLength(1);
    const { results } = await env.DB.prepare("SELECT DISTINCT action FROM audit_log").all<{ action: string }>();
    expect(results.map((r) => r.action).sort()).toEqual(["calibration.scored", "label.recorded", "label_set.imported", "predictions.imported"]);
  });

  it("scopes sets to their tenant", async () => {
    const setId = await importSet();
    await grant(L1, "playtrek-beta", "labeler");
    expect((await api(L1, "GET", `/tenants/playtrek-beta/label-sets/${setId}/queue`)).status).toBe(404);
  });
});
