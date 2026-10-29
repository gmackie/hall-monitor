import { expect, it } from "vitest";
import { chooseSyntheticDraft, createSyntheticDraft, editSyntheticDraft, renderSyntheticDemo, runSyntheticDemo, screenSyntheticDraft } from "../src/index.ts";

it("runs four fictional pairs through the actual core with explicit simulated provenance", async () => {
  const report = await runSyntheticDemo();
  expect(report.cases).toHaveLength(4);
  expect(report).toMatchObject({ mode: "synthetic", classifierBasis: "scripted-fixture", network: "none" });
  expect(report.cases.flatMap((c) => c.variants)).toHaveLength(8);
  expect(report.cases[0]!.variants.map((v) => v.result.decision)).toEqual(["allow", "block"]);
  expect(report.cases[1]!.variants[1]!.result.decision).toBe("allow");
  expect(report.outage.result).toMatchObject({ decision: "hold", degraded: { reason: "classifier_unavailable" } });
  expect(report.outage.support.decision).toBe("support");
  expect(report.analytics).toMatchObject({ coverage: "unavailable", candidateCount: null, liveData: false, humanResponse: "not-configured" });
  for (const v of report.cases.flatMap((c) => c.variants)) {
    expect(v.result.evaluatorBundleRevision).toContain("base-1.0.1");
    expect(JSON.stringify(v.result)).not.toContain(v.text);
    expect(v.draft.published).toBe(false);
    expect(v.result.receipt?.totalGrossUsdNano ?? "0").toBe("0");
    if (v.result.receipt !== null) expect(v.result.receipt.hasUnknownCost).toBe(true);
  }
});

it("preserves drafts and help/report paths without publishing held, blocked, coach or support results", async () => {
  const r = await runSyntheticDemo(), sample = r.cases[0]!.variants[0]!.result;
  for (const decision of ["hold", "block", "coach", "support"] as const) {
    const state = screenSyntheticDraft(createSyntheticDraft("SYNTHETIC_DRAFT", sample.requestId), { ...sample, decision });
    expect(chooseSyntheticDraft(state, "continue").published).toBe(false);
    expect(chooseSyntheticDraft(state, "report")).toMatchObject({ reportRequested: true, draft: "SYNTHETIC_DRAFT", helpVisible: true });
    expect(chooseSyntheticDraft(state, "help").helpVisible).toBe(true);
  }
  const outage = screenSyntheticDraft(createSyntheticDraft("KEEP_DRAFT", "outage_draft"), null);
  expect(chooseSyntheticDraft(outage, "continue").published).toBe(false);
  expect(chooseSyntheticDraft(outage, "report")).toMatchObject({ draft: "KEEP_DRAFT", reportRequested: true, helpVisible: true });
});

it("requires an explicit continue after the matching result, and discards stale results after editing", async () => {
  const sample = (await runSyntheticDemo()).cases[0]!.variants[0]!.result;
  const initial = createSyntheticDraft("First draft", sample.requestId);
  expect(chooseSyntheticDraft(initial, "continue").published).toBe(false);
  const screened = screenSyntheticDraft(initial, sample);
  expect(screened.published).toBe(false); expect(chooseSyntheticDraft(screened, "continue").published).toBe(true);
  const edited = editSyntheticDraft(screened, "Edited draft", "new_request");
  expect(screenSyntheticDraft(edited, sample)).toBe(edited);
  expect(chooseSyntheticDraft(edited, "continue").published).toBe(false);
  expect(() => editSyntheticDraft(screened, "Changed", screened.requestId)).toThrow("new synthetic request id");
});

it("renders a standalone accessible document with no scripts, external resources or submission", async () => {
  const r = await runSyntheticDemo();
  const attack = '</blockquote><script src="https://evil.invalid"></script>';
  const hostile = { ...r, cases: r.cases.map((c, i) => i === 0 ? { ...c, title: attack, variants: c.variants.map((v) => ({ ...v, text: attack })) } : c) };
  const html = renderSyntheticDemo(hostile);
  expect(html).toContain("&lt;script"); expect(html).not.toMatch(/<script|<form|<iframe|<img|\son\w+=|(?:src|href)=["']https?:/i);
  expect(html).toContain('lang="en"'); expect(html).toContain('aria-label="Walkthroughs"');
  expect(html).toContain("Proposed source experience"); expect(html).toContain("scripted scores");
  expect(html).toContain("Nothing publishes automatically");
});
