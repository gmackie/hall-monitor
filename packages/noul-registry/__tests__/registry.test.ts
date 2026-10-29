import { readFileSync } from "node:fs";
import { CLEF_CLASSIFIER_VERSION, CLEF_IMAGE_QUESTIONS, CLEF_QUESTIONS, buildClefInput, buildClefImageInput, clefQuestionsFromDefinitions, parseClefOutput } from "@gmacko/hall-monitor-clef";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import { describe, expect, it } from "vitest";
import { BASELINE_DECISION_PACK as pack, BASELINE_DECISION_PACK_PIN as pin, createDecisionRegistry, decisionPackDigest, parseDecisionPack, type DecisionSelection } from "../src/index.ts";

// Frozen independently from the committed pre-W2 protocol at 99d4e29, not generated during tests.
const golden = JSON.parse(readFileSync(new URL("./wire-baseline.json", import.meta.url), "utf8"));
const selection: DecisionSelection = {
  classifierVersion: CLEF_CLASSIFIER_VERSION, providerId: CLOUDFLARE_WORKERS_AI,
  modelIds: [CLEF_FLASH_MODEL, CLEF_MODEL], modality: "text",
  evaluationKind: "interaction.input", contextFields: ["audience", "evaluationKind"],
};
const installed = () => createDecisionRegistry([{ pack, pin }]);
const copy = () => JSON.parse(JSON.stringify(pack));

describe("immutable decision packs", () => {
  it("pins the complete manifest and definitions, including descriptive metadata", async () => {
    expect(await decisionPackDigest(pack)).toBe(pin.digest);
    const changed = copy();
    changed.definitions[0].negativeCriteria[0] += " revised";
    await expect(createDecisionRegistry([{ pack: changed, pin }])).rejects.toThrow("invalid decision-pack installation");
  });

  it("canonicalizes object keys, while binding ordered wire questions and exact string bytes", async () => {
    const reordered = Object.fromEntries(Object.entries(pack).reverse());
    expect(await decisionPackDigest(reordered)).toBe(pin.digest);
    const changed = copy();
    changed.definitions[0].questions[0].instructions += " ";
    expect(await decisionPackDigest(changed)).not.toBe(pin.digest);
    changed.definitions.reverse();
    expect(parseDecisionPack(changed)).toBeUndefined();
  });

  it("detaches caller aliases and recursively freezes parsed definitions", async () => {
    const value = copy();
    const parsed = parseDecisionPack(value)!;
    value.definitions[0].questions[0].instructions = "mutated";
    expect(parsed.definitions[0]!.questions[0]!.instructions).toBe(CLEF_QUESTIONS[0]!.instructions);
    expect(Object.isFrozen(parsed.definitions[0]!.questions[0])).toBe(true);
    const registry = await createDecisionRegistry([{ pack: parsed, pin }]);
    const questions = registry.questions(pin, selection)!;
    expect(Object.isFrozen(questions)).toBe(true);
    expect(Object.isFrozen(questions[0])).toBe(true);
  });

  it.each([
    ["extra root field", (p: any) => { p.extra = true; }],
    ["extra definition field", (p: any) => { p.definitions[0].threshold = 0.9; }],
    ["duplicate id", (p: any) => { p.definitions[1].id = p.definitions[0].id; p.manifest.decisions[1].id = p.definitions[0].id; }],
    ["definition version mismatch", (p: any) => { p.definitions[0].version = "2.0.0"; }],
    ["unsupported schema version", (p: any) => { p.schemaVersion = "2.0"; }],
    ["unsupported adapter version", (p: any) => { p.manifest.adapter = "clef-2"; }],
    ["missing image", (p: any) => { p.definitions[0].questions.pop(); }],
    ["duplicate modality", (p: any) => { p.definitions[0].questions[1].modality = "text"; }],
    ["missing criteria", (p: any) => { p.definitions[0].negativeCriteria = []; }],
    ["invented category", (p: any) => { p.definitions[0].category = "risk-score"; }],
    ["provider mismatch", (p: any) => { p.definitions[0].providerIds = ["other"]; }],
    ["fixture mismatch", (p: any) => { p.definitions[0].fixtureRevision = "other"; }],
    ["missing ownership", (p: any) => { delete p.definitions[0].provenance; }],
    ["unassigned claimed owner", (p: any) => { p.definitions[0].provenance.ownerAssignment = "assigned"; }],
    ["duplicate model", (p: any) => { p.manifest.providers[0].modelIds.push(p.manifest.providers[0].modelIds[0]); }],
  ])("rejects %s", (_name, mutate) => {
    const value = copy(); mutate(value);
    expect(parseDecisionPack(value)).toBeUndefined();
  });

  it("rejects duplicate installed pack identities", async () => {
    await expect(createDecisionRegistry([{ pack, pin }, { pack, pin }])).rejects.toThrow("invalid decision-pack installation");
  });
});

describe("server-selected Clef adapter", () => {
  it.each(["text", "image"] as const)("preserves all pre-W2 %s wire questions", async (modality) => {
    const registry = await installed();
    const questions = registry.questions(pin, { ...selection, modality })!;
    const expected = modality === "text" ? golden.CLEF_QUESTIONS : golden.CLEF_IMAGE_QUESTIONS;
    expect(questions).toEqual(expected);
    expect(questions).toEqual(modality === "text" ? CLEF_QUESTIONS : CLEF_IMAGE_QUESTIONS);
    const req = { context: { audience: "student", gradeBand: "9-12" }, evaluationKind: "interaction.input" } as EvaluationRequest;
    expect(JSON.stringify(buildClefInput(req, "synthetic input", questions))).toBe(JSON.stringify(buildClefInput(req, "synthetic input", expected)));
    if (modality === "image") {
      const content = { type: "image" as const, text: "synthetic input", images: [{ mimeType: "image/png" as const, base64: "aGVsbG8=" }] };
      expect(JSON.stringify(buildClefImageInput(req, content, questions))).toBe(JSON.stringify(buildClefImageInput(req, content, expected)));
    }
    const answers = Object.fromEntries(expected.map((q: { id: string }) => [q.id, { type: "noul", noul: 0.25 }]));
    expect(parseClefOutput({ answers }, questions)?.size).toBe(7);
    delete answers.self_harm;
    expect(parseClefOutput({ answers }, questions)).toBeNull();
  });

  it.each([
    undefined, null, {}, { ...pin, id: "missing" }, { ...pin, version: "2.0.0" },
    { ...pin, digest: "sha256:" + "f".repeat(64) }, { ...pin, fallback: true },
  ])("declines an absent or invalid pin %j", async (invalid) => {
    expect((await installed()).questions(invalid, selection)).toBeUndefined();
  });

  it.each([
    { classifierVersion: "2.0.0" }, { providerId: "unapproved" }, { modelIds: [CLEF_FLASH_MODEL, "other-model"] },
    { modelIds: [] }, { contextFields: [] },
  ])("declines incompatible selection %j", async (override) => {
    expect((await installed()).questions(pin, { ...selection, ...override })).toBeUndefined();
  });

  it("declines unsupported categories without silently omitting their questions", async () => {
    const changed = copy(); changed.definitions[0].category = "academic-integrity";
    const revisedPin = { ...pin, digest: await decisionPackDigest(changed) };
    const registry = await createDecisionRegistry([{ pack: changed, pin: revisedPin }]);
    expect(registry.questions(revisedPin, selection)).toBeUndefined();
  });

  it("enforces evaluation-kind applicability", async () => {
    const changed = copy(); changed.definitions[0].evaluationKinds = ["interaction.output"];
    const revisedPin = { ...pin, digest: await decisionPackDigest(changed) };
    const registry = await createDecisionRegistry([{ pack: changed, pin: revisedPin }]);
    expect(registry.questions(revisedPin, selection)).toBeUndefined();
    expect(registry.questions(revisedPin, { ...selection, evaluationKind: "interaction.output" })).toHaveLength(7);
  });

  it("declines image inference under a valid text-only pack", async () => {
    const changed = copy(); changed.manifest.modalities = ["text"];
    for (const definition of changed.definitions) definition.questions = definition.questions.filter((q: { modality: string }) => q.modality === "text");
    const revisedPin = { ...pin, digest: await decisionPackDigest(changed) };
    const registry = await createDecisionRegistry([{ pack: changed, pin: revisedPin }]);
    expect(registry.questions(revisedPin, selection)).toHaveLength(7);
    expect(registry.questions(revisedPin, { ...selection, modality: "image" })).toBeUndefined();
  });

  it("rejects installation under a different pack identity, even with a matching content digest", async () => {
    await expect(createDecisionRegistry([{ pack, pin: { ...pin, id: "another" } }])).rejects.toThrow("invalid decision-pack installation");
  });

  it("the standalone public adapter declines duplicate ids and missing modality", () => {
    const defs = pack.definitions;
    expect(clefQuestionsFromDefinitions([defs[0]!, defs[0]!], "text")).toBeUndefined();
    expect(clefQuestionsFromDefinitions([{ ...defs[0]!, questions: [] }], "image")).toBeUndefined();
    expect(clefQuestionsFromDefinitions([], "text")).toBeUndefined();
  });
});
