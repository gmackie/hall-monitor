import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import {
  type CalibrationInput,
  type CalibrationStudy,
  calibrationStudyDigest,
  parseCalibrationStudy,
  prepareCalibrationPacket,
  type ReviewPacket,
  scoreCalibration,
} from "@gmacko/hall-monitor-shadow-report";
import { z } from "zod";
import { auditStatement, newId } from "../audit.ts";
import { conflict, forbidden, invalid, json, notFound, readJson, segment } from "../http.ts";
import { tenantOf } from "../revisions.ts";
import { hasRole, requireRole } from "../roles.ts";
import { type Ctx, route, SEG } from "../router.ts";

const Label = z.enum(["positive", "negative", "ambiguous"]);
const LabelBody = z.strictObject({ labels: z.array(z.strictObject({ decisionId: OpaqueId, label: Label })).min(1).max(64) });
const AdjudicationBody = z.strictObject({ decisionId: OpaqueId, label: Label });
const PredictionsBody = z.strictObject({
  run: z.strictObject({ revision: OpaqueId, basis: z.enum(["simulated", "measured"]), providerId: OpaqueId, modelId: z.string().min(1).max(128) }),
  predictions: z.array(z.strictObject({ blindId: OpaqueId, decisionId: OpaqueId, score: z.number().min(0).max(1).nullable() })).max(100_000),
});

interface SetRow {
  id: string; tenant: string; family: string; study_json: string; study_digest: string; packet_json: string; blind_key_json: string; created_by: string; created_at: string;
}

const SETS = `/tenants/${SEG}/label-sets`;
const SET = `${SETS}/${SEG}`;

async function loadSet(ctx: Ctx): Promise<SetRow> {
  const tenant = tenantOf(ctx);
  // Read access to a set needs some label role on the tenant; viewers do not see case text.
  if (!["labeler", "adjudicator"].some((role) => hasRole(ctx.principal, tenant, role as "labeler" | "adjudicator"))) throw forbidden();
  const row = await ctx.env.DB.prepare("SELECT * FROM label_sets WHERE tenant = ?1 AND id = ?2").bind(tenant, segment(ctx.params[1]!)).first<SetRow>();
  if (row === null) throw notFound("label set not found");
  return row;
}

function packetOf(row: SetRow): ReviewPacket {
  return JSON.parse(row.packet_json) as ReviewPacket;
}

/** A packet item as a labeler sees it: blind id, cohort, content and instructions. Nothing else. */
function blindItem(item: ReviewPacket["items"][number]) {
  return { blindId: item.blindId, cohort: item.cohort, content: item.content, decisions: item.decisions };
}

function itemOf(row: SetRow, rawBlind: string) {
  const blindId = segment(rawBlind);
  const item = packetOf(row).items.find((candidate) => candidate.blindId === blindId);
  if (item === undefined) throw notFound("item not found");
  return item;
}

export const labelRoutes = [
  route("GET", SETS, async (ctx) => {
    const tenant = tenantOf(ctx);
    requireRole(ctx.principal, tenant, "viewer");
    const { results } = await ctx.env.DB.prepare(
      `SELECT s.id, s.family, s.study_digest AS studyDigest, s.created_by AS createdBy, s.created_at AS createdAt,
        (SELECT COUNT(*) FROM label_items i WHERE i.set_id = s.id AND i.tenant = s.tenant) AS items,
        (SELECT COUNT(*) FROM labels l WHERE l.set_id = s.id) AS labels,
        (SELECT COUNT(*) FROM adjudications a WHERE a.set_id = s.id) AS adjudications
       FROM label_sets s WHERE s.tenant = ?1 ORDER BY s.created_at DESC`,
    ).bind(tenant).all();
    return json({ tenant, labelSets: results });
  }),

  /**
   * Imports a calibration study as a label set (admin). Cases must be synthetic or licensed; the
   * study is frozen, digested and blinded here, and the blinding key never leaves D1.
   */
  route("POST", SETS, async (ctx) => {
    const tenant = tenantOf(ctx);
    if (!ctx.principal.isAdmin) throw forbidden();
    const body = await readJson(ctx.request) as { study?: unknown } | null;
    let study: CalibrationStudy;
    try {
      study = parseCalibrationStudy(body?.study);
    } catch {
      throw invalid("study must be a valid calibration study whose cases are synthetic or licensed");
    }
    if (study.cases.some((c) => c.origin.kind !== "synthetic" && c.origin.kind !== "licensed")) throw invalid("only synthetic or licensed cases may be labelled");
    const { packet, key } = prepareCalibrationPacket(study, () => newId("blind"));
    const id = newId("lset");
    const at = new Date().toISOString();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO label_sets (id, tenant, family, study_json, study_digest, packet_json, blind_key_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
        .bind(id, tenant, study.family ?? "clef", JSON.stringify(study), calibrationStudyDigest(study), JSON.stringify(packet), JSON.stringify(key), ctx.principal.email, at),
      ...packet.items.map((item) => ctx.env.DB.prepare("INSERT INTO label_items (set_id, blind_id, tenant) VALUES (?1, ?2, ?3)").bind(id, item.blindId, tenant)),
      auditStatement(ctx.env, ctx.principal.email, "label_set.imported", tenant, "label_set", id),
    ]);
    return json({ id, items: packet.items.length, studyDigest: calibrationStudyDigest(study) }, 201);
  }),

  /** The labeler's queue: blinded items they have not fully labelled. No key, split, ids, other labels or scores. */
  route("GET", `${SET}/queue`, async (ctx) => {
    const row = await loadSet(ctx);
    requireRole(ctx.principal, row.tenant, "labeler");
    const { results } = await ctx.env.DB.prepare("SELECT blind_id, decision_id FROM labels WHERE set_id = ?1 AND reviewer = ?2").bind(row.id, ctx.principal.email).all<{ blind_id: string; decision_id: string }>();
    const mine = new Set(results.map((r) => `${r.blind_id}\n${r.decision_id}`));
    const items = packetOf(row).items.filter((item) => item.decisions.some((d) => !mine.has(`${item.blindId}\n${d.id}`)));
    return json({ setId: row.id, family: row.family, remaining: items.length, items: items.slice(0, 50).map(blindItem) });
  }),

  route("POST", `${SET}/items/${SEG}/labels`, async (ctx) => {
    const row = await loadSet(ctx);
    requireRole(ctx.principal, row.tenant, "labeler");
    const item = itemOf(row, ctx.params[2]!);
    const body = LabelBody.safeParse(await readJson(ctx.request));
    if (!body.success) throw invalid("body is {labels: [{decisionId, label}]}");
    const decisions = new Set(item.decisions.map((d) => d.id));
    if (body.data.labels.some((l) => !decisions.has(l.decisionId))) throw invalid("unknown decision");
    const adjudicated = await ctx.env.DB.prepare("SELECT 1 FROM adjudications WHERE set_id = ?1 AND blind_id = ?2 AND adjudicator = ?3").bind(row.id, item.blindId, ctx.principal.email).first();
    if (adjudicated !== null) throw conflict("you adjudicated this item, so you cannot also label it");
    const at = new Date().toISOString();
    await ctx.env.DB.batch([
      ...body.data.labels.map((l) => ctx.env.DB.prepare(
        "INSERT INTO labels (set_id, blind_id, decision_id, reviewer, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (set_id, blind_id, decision_id, reviewer) DO UPDATE SET label = ?5, created_at = ?6",
      ).bind(row.id, item.blindId, l.decisionId, ctx.principal.email, l.label, at)),
      auditStatement(ctx.env, ctx.principal.email, "label.recorded", row.tenant, "label_item", `${row.id}/${item.blindId}`),
    ]);
    return json({ recorded: body.data.labels.length });
  }),

  /**
   * Items and decisions that have two or more independent labels, disagree, and are not yet
   * adjudicated, excluding items the adjudicator labelled. Shows label counts, never reviewers.
   */
  route("GET", `${SET}/adjudication-queue`, async (ctx) => {
    const row = await loadSet(ctx);
    requireRole(ctx.principal, row.tenant, "adjudicator");
    const { results } = await ctx.env.DB.prepare("SELECT blind_id, decision_id, reviewer, label FROM labels WHERE set_id = ?1").bind(row.id).all<{ blind_id: string; decision_id: string; reviewer: string; label: string }>();
    const done = new Set((await ctx.env.DB.prepare("SELECT blind_id, decision_id FROM adjudications WHERE set_id = ?1").bind(row.id).all<{ blind_id: string; decision_id: string }>())
      .results.map((r) => `${r.blind_id}\n${r.decision_id}`));
    const groups = new Map<string, { reviewers: Set<string>; counts: Record<string, number> }>();
    const reviewedByMe = new Set<string>();
    for (const r of results) {
      if (r.reviewer === ctx.principal.email) reviewedByMe.add(r.blind_id);
      const key = `${r.blind_id}\n${r.decision_id}`;
      const group = groups.get(key) ?? { reviewers: new Set(), counts: {} };
      group.reviewers.add(r.reviewer);
      group.counts[r.label] = (group.counts[r.label] ?? 0) + 1;
      groups.set(key, group);
    }
    const packet = packetOf(row);
    const items = packet.items.flatMap((item) => reviewedByMe.has(item.blindId) ? [] : item.decisions.flatMap((d) => {
      const key = `${item.blindId}\n${d.id}`;
      const group = groups.get(key);
      if (group === undefined || done.has(key) || group.reviewers.size < 2 || Object.keys(group.counts).length < 2) return [];
      return [{ ...blindItem(item), decisions: [d], counts: group.counts }];
    }));
    return json({ setId: row.id, items: items.slice(0, 50), remaining: items.length });
  }),

  route("POST", `${SET}/items/${SEG}/adjudication`, async (ctx) => {
    const row = await loadSet(ctx);
    requireRole(ctx.principal, row.tenant, "adjudicator");
    const item = itemOf(row, ctx.params[2]!);
    const body = AdjudicationBody.safeParse(await readJson(ctx.request));
    if (!body.success || !item.decisions.some((d) => d.id === body.data.decisionId)) throw invalid("body is {decisionId, label}");
    const reviewed = await ctx.env.DB.prepare("SELECT 1 FROM labels WHERE set_id = ?1 AND blind_id = ?2 AND reviewer = ?3").bind(row.id, item.blindId, ctx.principal.email).first();
    if (reviewed !== null) throw conflict("you labelled this item, so you cannot adjudicate it");
    const reviewers = await ctx.env.DB.prepare("SELECT COUNT(DISTINCT reviewer) AS n FROM labels WHERE set_id = ?1 AND blind_id = ?2 AND decision_id = ?3").bind(row.id, item.blindId, body.data.decisionId).first<{ n: number }>();
    if ((reviewers?.n ?? 0) < 2) throw conflict("adjudication needs at least two independent labels first");
    try {
      await ctx.env.DB.batch([
        ctx.env.DB.prepare("INSERT INTO adjudications (set_id, blind_id, decision_id, adjudicator, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(row.id, item.blindId, body.data.decisionId, ctx.principal.email, body.data.label, new Date().toISOString()),
        auditStatement(ctx.env, ctx.principal.email, "adjudication.recorded", row.tenant, "label_item", `${row.id}/${item.blindId}`),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY/i.test(error.message)) throw conflict("already adjudicated");
      throw error;
    }
    return json({ recorded: 1 });
  }),

  /** Imports one run's model scores for the set (adjudicator or admin). Replaces any earlier import. */
  route("POST", `${SET}/predictions`, async (ctx) => {
    const row = await loadSet(ctx);
    requireRole(ctx.principal, row.tenant, "adjudicator");
    const body = PredictionsBody.safeParse(await readJson(ctx.request));
    if (!body.success) throw invalid("body is {run: {revision, basis, providerId, modelId}, predictions: [{blindId, decisionId, score}]}");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO predictions (set_id, json) VALUES (?1, ?2) ON CONFLICT (set_id) DO UPDATE SET json = ?2").bind(row.id, JSON.stringify(body.data)),
      auditStatement(ctx.env, ctx.principal.email, "predictions.imported", row.tenant, "label_set", row.id),
    ]);
    return json({ predictions: body.data.predictions.length });
  }),

  /**
   * Scores the set's held-out cases: the stored study, key, every label (reviewers pseudonymized
   * per set), every adjudication and the imported predictions go through `scoreCalibration`.
   * The report is a candidate only (`activation: "not-approved"`).
   */
  route("POST", `${SET}:score`, async (ctx) => {
    const tenant = tenantOf(ctx);
    if (!hasRole(ctx.principal, tenant, "adjudicator")) throw forbidden();
    const row = await loadSet(ctx);
    const predictions = await ctx.env.DB.prepare("SELECT json FROM predictions WHERE set_id = ?1").bind(row.id).first<{ json: string }>();
    if (predictions === null) throw conflict("import predictions before scoring");
    const run = JSON.parse(predictions.json) as z.infer<typeof PredictionsBody>;
    const labels = await ctx.env.DB.prepare("SELECT blind_id, decision_id, reviewer, label FROM labels WHERE set_id = ?1 ORDER BY reviewer").bind(row.id).all<{ blind_id: string; decision_id: string; reviewer: string; label: "positive" | "negative" | "ambiguous" }>();
    const adjudications = await ctx.env.DB.prepare("SELECT blind_id, decision_id, adjudicator, label FROM adjudications WHERE set_id = ?1").bind(row.id).all<{ blind_id: string; decision_id: string; adjudicator: string; label: "positive" | "negative" | "ambiguous" }>();
    const refs = new Map<string, string>();
    const ref = (email: string) => refs.get(email) ?? (refs.set(email, `person_${refs.size + 1}`), refs.get(email)!);
    const study = JSON.parse(row.study_json) as CalibrationStudy;
    const packet = packetOf(row);
    const input: CalibrationInput = {
      schemaVersion: "1.0", studyRevision: study.revision, studyDigest: row.study_digest, packetDigest: packet.packetDigest,
      corpusRevision: study.corpusRevision, packDigest: study.pack.digest, run: run.run,
      key: JSON.parse(row.blind_key_json) as Record<string, string>,
      reviews: labels.results.map((l) => ({ reviewerRef: ref(l.reviewer), blindId: l.blind_id, decisionId: l.decision_id, label: l.label })),
      adjudications: adjudications.results.map((a) => ({ adjudicatorRef: ref(a.adjudicator), blindId: a.blind_id, decisionId: a.decision_id, label: a.label })),
      predictions: run.predictions,
    };
    let report;
    try {
      report = scoreCalibration(study, input);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "calibration input rejected");
    }
    const id = newId("calrep");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO calibration_reports (id, set_id, tenant, report_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(id, row.id, row.tenant, JSON.stringify(report), ctx.principal.email, new Date().toISOString()),
      auditStatement(ctx.env, ctx.principal.email, "calibration.scored", row.tenant, "calibration_report", id),
    ]);
    return json({ id, report }, 201);
  }),

  route("GET", `${SET}/calibration-reports`, async (ctx) => {
    const row = await loadSet(ctx);
    const { results } = await ctx.env.DB.prepare("SELECT id, report_json, created_by AS createdBy, created_at AS createdAt FROM calibration_reports WHERE tenant = ?1 AND set_id = ?2 ORDER BY created_at DESC")
      .bind(row.tenant, row.id).all<{ id: string; report_json: string; createdBy: string; createdAt: string }>();
    return json({ reports: results.map((r) => ({ id: r.id, createdBy: r.createdBy, createdAt: r.createdAt, report: JSON.parse(r.report_json) })) });
  }),
];
