import { OpaqueId, Timestamp } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

export const SafetyScope = z.strictObject({ tenantId: OpaqueId, caseId: OpaqueId });
export type SafetyScope = z.infer<typeof SafetyScope>;
export const SafetyReference = z.strictObject({ tenantId: OpaqueId, caseId: OpaqueId,
  kind: z.enum(["person", "group", "evidence", "evidence-group"]), token: z.string().regex(/^[a-f0-9]{64}$/) });
export type SafetyReference = z.infer<typeof SafetyReference>;
const ref = (kind: SafetyReference["kind"]) => SafetyReference.refine((r) => r.kind === kind);
const Person = ref("person"), Evidence = ref("evidence");
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const Permission = z.strictObject({
  kind: z.literal("permission.transition"), actor: Person, target: Person, group: ref("group"), evidence: Evidence,
  purpose: z.enum(["required-group-work", "optional-social", "unknown"]),
  authority: z.strictObject({ actorRole: z.enum(["staff", "delegated-student-moderator"]), actorEnrollmentVerified: z.literal(true),
    targetEnrollmentVerified: z.literal(true), permissionVerified: z.literal(true) }),
  from: z.enum(["member", "removed"]), to: z.enum(["member", "removed"]),
}).refine((p) => p.from !== p.to);
const Report = z.strictObject({
  kind: z.literal("report.allegation"), reporter: Person, subjects: z.array(Person).max(8), evidence: Evidence,
  evidenceGroup: ref("evidence-group"), independence: z.enum(["source-verified", "unverified"]),
  provenance: z.enum(["source-message", "copied-report", "unverified-capture"]),
  speechAct: z.enum(["direct-report", "supportive-report", "forwarded-rumor", "quoted-material"]),
  concern: z.enum(["access-loss", "harassment", "threat", "other"]),
});
const Model = z.strictObject({
  kind: z.literal("model.assertion"), evidence: Evidence, modelId: z.string().min(1).max(128),
  modelRevision: OpaqueId, calibrationRevision: OpaqueId,
  subjects: z.array(Person).max(8), concern: z.enum(["access-loss", "harassment", "threat", "other"]), confidence: z.number().min(0).max(1),
});
const Retraction = z.strictObject({ kind: z.literal("record.retracted"), reason: z.enum(["wrong-attribution", "source-correction", "withdrawn"]) });

/** A synthetic fixture protocol, intentionally excluded from public evaluation and telemetry. */
export const SafetyEvent = z.strictObject({
  schemaVersion: z.literal("1.0"), mode: z.literal("synthetic"), scope: SafetyScope, producerId: OpaqueId, recordId: OpaqueId,
  version: z.number().int().min(1).max(128), previousDigest: Digest.nullable(), occurredAt: Timestamp, expiresAt: Timestamp,
  revisionKind: z.enum(["initial", "transition", "correction", "retraction"]),
  dependencies: z.array(z.strictObject({ recordId: OpaqueId, digest: Digest })).max(16),
  category: z.enum(["observed", "reported", "model"]), assertion: z.union([Permission, Report, Model, Retraction]),
}).superRefine((event, ctx) => {
  const issue = () => ctx.addIssue({ code: "custom", message: "invalid restricted event" });
  if ((event.version === 1) !== (event.previousDigest === null) || Date.parse(event.expiresAt) <= Date.parse(event.occurredAt)) issue();
  if ((event.version === 1) !== (event.revisionKind === "initial") ||
      (event.revisionKind === "transition" && event.assertion.kind !== "permission.transition") ||
      (event.revisionKind === "retraction") !== (event.assertion.kind === "record.retracted") ||
      event.dependencies.some((d) => d.recordId === event.recordId) ||
      new Set(event.dependencies.map((d) => d.recordId)).size !== event.dependencies.length) issue();
  const a = event.assertion;
  if ((a.kind === "permission.transition" && event.category !== "observed") || (a.kind === "report.allegation" && event.category !== "reported") ||
      (a.kind === "model.assertion" && event.category !== "model") || (a.kind === "record.retracted" && event.version === 1)) issue();
  const refs = a.kind === "permission.transition" ? [a.actor, a.target, a.group, a.evidence] : a.kind === "report.allegation"
    ? [a.reporter, ...a.subjects, a.evidence, a.evidenceGroup] : a.kind === "model.assertion" ? [...a.subjects, a.evidence] : [];
  if (refs.some((r) => r.tenantId !== event.scope.tenantId || r.caseId !== event.scope.caseId)) issue();
  if ("subjects" in a && new Set(a.subjects.map((r) => r.token)).size !== a.subjects.length) issue();
});
export type SafetyEvent = z.infer<typeof SafetyEvent>;

export function parseSafetyEvent(input: unknown): SafetyEvent | undefined {
  const parsed = SafetyEvent.safeParse(input);
  return parsed.success ? freezeSafetyValue(parsed.data) : undefined;
}
export function freezeSafetyValue<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const v of Object.values(value)) freezeSafetyValue(v); Object.freeze(value); }
  return value;
}
