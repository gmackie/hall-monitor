import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { CalibrationBand, CalibrationCohort as Cohort } from "@gmacko/hall-monitor-clef";
import { BASELINE_DECISION_PACK, BASELINE_DECISION_PACK_PIN } from "@gmacko/hall-monitor-noul-registry";
import { createHash } from "node:crypto";
import { z } from "zod";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type CalibrationCohort = z.infer<typeof Cohort>;
const Case = z.strictObject({
  id: OpaqueId, familyId: OpaqueId, split: z.enum(["development", "calibration", "held-out"]),
  origin: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("synthetic") }), z.strictObject({ kind: z.literal("licensed"), rightsRef: OpaqueId })]),
  cohort: Cohort,
  content: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(32_000) }),
    z.strictObject({ type: z.literal("image"), assetRef: OpaqueId, text: z.string().max(32_000).optional() })]),
}).refine((c) => c.content.type === c.cohort.modality);

const Study = z.strictObject({
  schemaVersion: z.literal("1.0"), revision: OpaqueId, corpusRevision: OpaqueId,
  pack: z.strictObject({ id: OpaqueId, version: OpaqueId, digest: Digest }),
  decisions: z.array(z.strictObject({ id: OpaqueId, textInstructions: z.string().min(1).max(2048), imageInstructions: z.string().min(1).max(2048) })).min(1).max(64),
  cases: z.array(Case).min(1).max(4000),
  bands: z.array(z.strictObject({ decisionId: OpaqueId, cohort: Cohort, providerId: OpaqueId,
    modelId: z.string().min(1).max(128), band: CalibrationBand })).max(4000),
});
export type CalibrationStudy = z.infer<typeof Study>;
const cohortKey = (c: CalibrationCohort) => JSON.stringify([c.profileId, c.profileRevision, c.gradeBand, c.language, c.modality, c.evaluationKind, c.audience]);
const pairKey = (id: string, question: string) => JSON.stringify([id, question]);
const bandKey = (c: CalibrationCohort, id: string) => JSON.stringify([cohortKey(c), id]);
const unique = (keys: readonly string[]) => new Set(keys).size === keys.length;

/** Freeze split/family assignments before prediction or label import. Unknown values never echo. */
export function parseCalibrationStudy(input: unknown): CalibrationStudy {
  const parsed = Study.safeParse(input);
  if (!parsed.success) throw new Error("invalid calibration study");
  const s = parsed.data;
  const pin = BASELINE_DECISION_PACK_PIN;
  if (s.pack.id !== pin.id || s.pack.version !== pin.version || s.pack.digest !== pin.digest ||
      s.decisions.length !== BASELINE_DECISION_PACK.definitions.length || s.decisions.some((d, i) => {
        const definition = BASELINE_DECISION_PACK.definitions[i];
        return definition?.id !== d.id || d.textInstructions !== definition.questions.find((q) => q.modality === "text")?.instructions ||
          d.imageInstructions !== definition.questions.find((q) => q.modality === "image")?.instructions;
      })) throw new Error("calibration pack mismatch");
  const families = new Map<string, string>();
  const decisions = new Set(s.decisions.map((d) => d.id));
  if (!unique(s.cases.map((c) => c.id)) || !unique(s.decisions.map((d) => d.id)) ||
      !unique(s.bands.map((b) => JSON.stringify([bandKey(b.cohort, b.decisionId), b.providerId, b.modelId]))) || s.bands.some((b) => !decisions.has(b.decisionId) ||
        !BASELINE_DECISION_PACK.manifest.providers.some((p) => p.id === b.providerId && p.modelIds.includes(b.modelId)))) throw new Error("invalid calibration study");
  for (const c of s.cases) {
    if (families.has(c.familyId) && families.get(c.familyId) !== c.split) throw new Error("calibration family crosses data splits");
    families.set(c.familyId, c.split);
  }
  return freeze(s);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}

export interface ReviewPacket {
  readonly schemaVersion: "1.0";
  readonly studyRevision: string;
  readonly studyDigest: string;
  readonly packetDigest: string;
  readonly items: readonly {
    readonly blindId: string;
    readonly cohort: CalibrationCohort;
    readonly content: CalibrationStudy["cases"][number]["content"];
    readonly decisions: readonly { readonly id: string; readonly instructions: string }[];
  }[];
}

/** Packet excludes source ids, split, thresholds, author expectations, model scores and labels. */
export function prepareCalibrationPacket(input: unknown, newBlindId: () => string): { packet: ReviewPacket; key: Readonly<Record<string, string>> } {
  const study = parseCalibrationStudy(input), key: Record<string, string> = Object.create(null);
  const sourceIds = new Set(study.cases.map((c) => c.id));
  for (const c of study.cases) {
    const blindId = newBlindId();
    if (!OpaqueId.safeParse(blindId).success || sourceIds.has(blindId) || Object.hasOwn(key, blindId)) throw new Error("invalid blinding assignment");
    key[blindId] = c.id;
  }
  return freeze({ packet: packetFor(study, key), key });
}

function packetFor(study: CalibrationStudy, key: Readonly<Record<string, string>>): ReviewPacket {
  const blindIds = new Map(Object.entries(key).map(([blindId, id]) => [id, blindId]));
  const items = study.cases.map((c) => {
    const blindId = blindIds.get(c.id)!;
    return { blindId, cohort: c.cohort, content: c.content,
      decisions: study.decisions.map((d) => ({ id: d.id, instructions: c.cohort.modality === "text" ? d.textInstructions : d.imageInstructions })) };
  }).sort((a, b) => a.blindId < b.blindId ? -1 : a.blindId > b.blindId ? 1 : 0);
  const payload = { schemaVersion: "1.0" as const, studyRevision: study.revision, studyDigest: calibrationStudyDigest(study), items };
  return { ...payload, packetDigest: digest("packet", payload) };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function digest(domain: "study" | "packet", value: unknown): string {
  return `sha256:${createHash("sha256").update(`hall-monitor/calibration-${domain}/v1\n${canonical(value)}`).digest("hex")}`;
}
/** Pins cases, split/family membership, applicability, instructions and selected bands together. */
export function calibrationStudyDigest(study: unknown): string {
  return digest("study", parseCalibrationStudy(study));
}

const Label = z.enum(["positive", "negative", "ambiguous"]);
const Input = z.strictObject({
  schemaVersion: z.literal("1.0"), studyRevision: OpaqueId, studyDigest: Digest, packetDigest: Digest, corpusRevision: OpaqueId, packDigest: Digest,
  // Supplied explicitly by the run owner; importing predictions never invokes a provider.
  run: z.strictObject({ revision: OpaqueId, basis: z.enum(["simulated", "measured"]), providerId: OpaqueId, modelId: z.string().min(1).max(128) }),
  key: z.record(OpaqueId, OpaqueId),
  reviews: z.array(z.strictObject({ reviewerRef: OpaqueId, blindId: OpaqueId, decisionId: OpaqueId, label: Label })).max(100_000),
  adjudications: z.array(z.strictObject({ adjudicatorRef: OpaqueId, blindId: OpaqueId, decisionId: OpaqueId, label: Label })).max(100_000),
  predictions: z.array(z.strictObject({ blindId: OpaqueId, decisionId: OpaqueId, score: z.number().min(0).max(1).nullable() })).max(100_000),
});
export type CalibrationInput = z.infer<typeof Input>;

export interface Interval { readonly successes: number; readonly total: number; readonly rate: number | null; readonly lower95: number | null; readonly upper95: number | null }
/** Wilson binomial interval; descriptive only for correlated synthetic fixtures. */
export function calibrationInterval(successes: number, total: number): Interval {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < successes) throw new Error("invalid calibration counts");
  if (total === 0) return { successes, total, rate: null, lower95: null, upper95: null };
  const rate = successes / total, z95 = 1.959963984540054, a = z95 * z95 / total;
  const center = (rate + a / 2) / (1 + a), half = z95 * Math.sqrt(rate * (1 - rate) / total + a / (4 * total)) / (1 + a);
  return { successes, total, rate, lower95: Math.max(0, center - half), upper95: Math.min(1, center + half) };
}

export interface CalibrationMetric {
  readonly cohort: CalibrationCohort;
  readonly decisionId: string;
  cases: number; adjudicated: number; unresolved: number; disagreements: number;
  truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number;
  positiveAbstentions: number; negativeAbstentions: number; missingScores: number; missingBand: number;
  precision: Interval; recall: Interval; falsePositiveRate: Interval; coverage: Interval; labelCoverage: Interval;
}
export interface CalibrationReport {
  readonly schemaVersion: "1.0"; readonly kind: "calibration-candidate";
  readonly studyRevision: string; readonly corpusRevision: string; readonly packDigest: string;
  readonly studyDigest: string;
  readonly packetDigest: string;
  readonly provenance: "operator-declared";
  readonly basis: "simulated" | "measured"; readonly runRevision: string;
  readonly providerId: string; readonly modelId: string;
  readonly splitCases: Readonly<Record<"development" | "calibration" | "held-out", number>>;
  readonly evaluationSplit: "held-out"; readonly activation: "not-approved";
  readonly metrics: readonly CalibrationMetric[];
}

/** Ground truth requires independent review; the model and author expectations never supply it. */
export function scoreCalibration(inputStudy: unknown, value: unknown): CalibrationReport {
  const s = parseCalibrationStudy(inputStudy), result = Input.safeParse(value);
  if (!result.success) throw new Error("invalid calibration observations");
  const input = result.data;
  if (!BASELINE_DECISION_PACK.manifest.providers.some((p) => p.id === input.run.providerId && p.modelIds.includes(input.run.modelId))) throw new Error("unsupported calibration model");
  const studyDigest = calibrationStudyDigest(s);
  if (input.studyRevision !== s.revision || input.studyDigest !== studyDigest || input.corpusRevision !== s.corpusRevision || input.packDigest !== s.pack.digest) throw new Error("calibration revision mismatch");
  const cases = new Map(s.cases.map((c) => [c.id, c]));
  const ids = new Set(s.decisions.map((d) => d.id));
  const mapping = Object.entries(input.key);
  if (mapping.length !== s.cases.length || !unique(mapping.map(([, id]) => id)) || mapping.some(([, id]) => !cases.has(id))) throw new Error("invalid calibration key");
  if (packetFor(s, input.key).packetDigest !== input.packetDigest) throw new Error("calibration packet mismatch");
  const known = (r: { blindId: string; decisionId: string }) => Object.hasOwn(input.key, r.blindId) && ids.has(r.decisionId);
  const rows = [...input.reviews, ...input.adjudications, ...input.predictions];
  if (rows.some((r) => !known(r)) || !unique(input.reviews.map((r) => JSON.stringify([r.reviewerRef, r.blindId, r.decisionId]))) ||
      !unique(input.adjudications.map((r) => pairKey(r.blindId, r.decisionId))) || !unique(input.predictions.map((r) => pairKey(r.blindId, r.decisionId)))) throw new Error("invalid calibration observations");
  const reviews = new Map<string, CalibrationInput["reviews"]>();
  for (const r of input.reviews) { const k = pairKey(r.blindId, r.decisionId); reviews.set(k, [...(reviews.get(k) ?? []), r]); }
  const adjudications = new Map(input.adjudications.map((r) => [pairKey(r.blindId, r.decisionId), r]));
  for (const [k, adjudication] of adjudications) {
    const independent = reviews.get(k) ?? [];
    if (independent.length < 2 || independent.some((r) => r.reviewerRef === adjudication.adjudicatorRef)) throw new Error("adjudication is not independent");
  }
  const predictions = new Map(input.predictions.map((r) => [pairKey(r.blindId, r.decisionId), r.score]));
  const bands = new Map(s.bands.filter((b) => b.providerId === input.run.providerId && b.modelId === input.run.modelId)
    .map((b) => [bandKey(b.cohort, b.decisionId), b.band]));
  const metrics = new Map<string, CalibrationMetric>();
  for (const [blindId, id] of mapping) {
    const c = cases.get(id)!;
    if (c.split !== "held-out") continue;
    for (const d of s.decisions) {
      const k = pairKey(blindId, d.id), cohort = bandKey(c.cohort, d.id);
      let m = metrics.get(cohort);
      if (m === undefined) {
        m = { cohort: c.cohort, decisionId: d.id, cases: 0, adjudicated: 0, unresolved: 0, disagreements: 0,
          truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0, positiveAbstentions: 0, negativeAbstentions: 0,
          missingScores: 0, missingBand: 0, precision: calibrationInterval(0, 0), recall: calibrationInterval(0, 0),
          falsePositiveRate: calibrationInterval(0, 0), coverage: calibrationInterval(0, 0), labelCoverage: calibrationInterval(0, 0) };
        metrics.set(cohort, m);
      }
      m.cases++;
      const labels = reviews.get(k) ?? [];
      const disagree = new Set(labels.map((r) => r.label)).size > 1;
      if (disagree) m.disagreements++;
      const adjudication = adjudications.get(k);
      const truth = labels.length < 2 ? undefined : adjudication?.label ?? (!disagree ? labels[0]?.label : undefined);
      if (truth === undefined || truth === "ambiguous") { m.unresolved++; continue; }
      m.adjudicated++;
      const score = predictions.get(k), band = bands.get(cohort);
      if (band === undefined) m.missingBand++;
      if (score === undefined || score === null) m.missingScores++;
      if (band === undefined || score === undefined || score === null || (score >= band.low && score < band.high)) {
        if (truth === "positive") m.positiveAbstentions++; else m.negativeAbstentions++;
      } else if (score >= band.high) {
        if (truth === "positive") m.truePositives++; else m.falsePositives++;
      } else if (truth === "positive") m.falseNegatives++; else m.trueNegatives++;
    }
  }
  for (const m of metrics.values()) {
    m.precision = calibrationInterval(m.truePositives, m.truePositives + m.falsePositives);
    // Include positive abstentions in recall's denominator; errors and missing scores cannot improve recall.
    m.recall = calibrationInterval(m.truePositives, m.truePositives + m.falseNegatives + m.positiveAbstentions);
    // Conditional FPR cannot improve by abstaining on a negative. Report all abstentions separately.
    m.falsePositiveRate = calibrationInterval(m.falsePositives, m.falsePositives + m.trueNegatives);
    m.coverage = calibrationInterval(m.truePositives + m.falsePositives + m.trueNegatives + m.falseNegatives, m.cases);
    m.labelCoverage = calibrationInterval(m.adjudicated, m.cases);
  }
  return freeze({ schemaVersion: "1.0", kind: "calibration-candidate", studyRevision: s.revision, corpusRevision: s.corpusRevision,
    packDigest: s.pack.digest, studyDigest, packetDigest: input.packetDigest, provenance: "operator-declared", basis: input.run.basis, runRevision: input.run.revision,
    providerId: input.run.providerId, modelId: input.run.modelId,
    splitCases: { development: s.cases.filter((c) => c.split === "development").length, calibration: s.cases.filter((c) => c.split === "calibration").length,
      "held-out": s.cases.filter((c) => c.split === "held-out").length },
    evaluationSplit: "held-out", activation: "not-approved",
    metrics: [...metrics.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, m]) => m) });
}
