import { EvaluationKind, OpaqueId, Product } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

const Seconds = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Revision = z.string().regex(/^[a-f0-9]{40}$/);
export const DataClass = z.enum(["synthetic", "staff", "student"]);
export const AgeEligibility = z.enum(["synthetic", "adult", "13-plus", "under-13", "unknown", "ineligible"]);
const EligibleAge = AgeEligibility.exclude(["unknown", "ineligible"]);
export const Route = z.strictObject({
  providerId: z.literal("cloudflare-workers-ai"),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  workerName: OpaqueId,
  kind: z.enum(["direct", "gateway"]),
  gatewayId: OpaqueId.nullable(),
  sourceRevision: Revision,
  modelIds: z.array(z.enum(["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"])).min(1).max(2),
}).refine((r) => (r.kind === "direct") === (r.gatewayId === null))
  .refine((r) => new Set(r.modelIds).size === r.modelIds.length);
export type Route = z.infer<typeof Route>;

/** Signed by the existing service JWT issuer; contains no student identity or birth date. */
export const GovernanceContext = z.strictObject({
  schemaVersion: z.literal("1.0"),
  institutionId: OpaqueId,
  requestId: OpaqueId,
  product: Product,
  surface: OpaqueId,
  purpose: OpaqueId,
  dataClass: DataClass,
  ageEligibility: AgeEligibility,
  eligibilityRef: OpaqueId,
  policyRevision: OpaqueId,
  issuedAt: Seconds,
  expiresAt: Seconds,
}).refine((c) => c.issuedAt < c.expiresAt);
export type GovernanceContext = Readonly<z.infer<typeof GovernanceContext>>;

export const Enrollment = z.strictObject({
  institutionId: OpaqueId,
  issuers: z.array(z.string().min(1).max(512)).min(1).max(16),
  product: Product,
  surfaces: z.array(OpaqueId).min(1).max(32),
  purposes: z.array(z.strictObject({ id: OpaqueId, evaluationKinds: z.array(EvaluationKind).min(1).max(4) })).min(1).max(16),
  dataClasses: z.array(DataClass).min(1).max(3),
  ageEligibility: z.array(EligibleAge).min(1).max(4),
  policyRevision: OpaqueId,
  approvalRef: OpaqueId,
  agreementRef: OpaqueId,
  approvedFrom: Seconds,
  approvedUntil: Seconds,
  maxEligibilityAgeSeconds: z.int().min(1).max(3600),
  revoked: z.boolean(),
  route: Route,
}).refine((e) => e.approvedFrom < e.approvedUntil)
  .refine((e) => new Set(e.purposes.map((p) => p.id)).size === e.purposes.length);
export type Enrollment = z.infer<typeof Enrollment>;

export const Observation = z.enum(["disabled", "enabled", "unverified", "not_applicable"]);
export const Observations = z.strictObject({
  workerObservability: Observation,
  accountLogpush: Observation,
  gatewayLogs: Observation,
  gatewayCache: Observation,
  aiBinding: z.enum(["matched", "mismatched", "unverified"]),
  route: z.enum(["matched", "mismatched", "unverified"]),
  modelRetention: z.enum(["approved", "denied", "unverified"]),
});
export type Observations = z.infer<typeof Observations>;

/** Operator-installed configuration evidence, not a claim of physical erasure or legal compliance. */
export const PrivacyAttestation = z.strictObject({
  schemaVersion: z.literal("1.0"),
  institutionId: OpaqueId,
  policyRevision: OpaqueId,
  approvalRef: OpaqueId,
  agreementRef: OpaqueId,
  verifierRef: OpaqueId,
  route: Route,
  dataClasses: z.array(DataClass).min(1).max(3),
  ageEligibility: z.array(EligibleAge).min(1).max(4),
  checkedAt: Seconds,
  expiresAt: Seconds,
  observations: Observations,
  result: z.enum(["verified", "unverified", "denied"]),
}).refine((a) => a.checkedAt < a.expiresAt);
export type PrivacyAttestation = z.infer<typeof PrivacyAttestation>;

export const GovernanceConfig = z.strictObject({
  schemaVersion: z.literal("1.0"),
  tenants: z.record(OpaqueId, Enrollment),
  evidence: z.record(OpaqueId, PrivacyAttestation),
});
export type GovernanceConfig = z.infer<typeof GovernanceConfig>;

/** Missing means no new enrollment. Malformed explicit configuration is a global model deny. */
export function parseGovernanceConfig(setting: string | undefined): GovernanceConfig | undefined {
  if (setting === undefined) return { schemaVersion: "1.0", tenants: {}, evidence: {} };
  try {
    const result = GovernanceConfig.safeParse(JSON.parse(setting));
    return result.success ? result.data : undefined;
  } catch { return undefined; }
}

export function observationsAllow(route: Route, o: Observations): boolean {
  return o.workerObservability === "disabled" && o.accountLogpush === "disabled" &&
    o.aiBinding === "matched" && o.route === "matched" && o.modelRetention === "approved" &&
    (route.kind === "direct" ? o.gatewayLogs === "not_applicable" && o.gatewayCache === "not_applicable"
      : o.gatewayLogs === "disabled" && o.gatewayCache === "disabled");
}
