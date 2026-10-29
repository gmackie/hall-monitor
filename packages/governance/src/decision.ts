import type { EvaluationKind, Product } from "@gmacko/hall-monitor-contracts";
import { type GovernanceConfig, type GovernanceContext, observationsAllow } from "./policy.ts";

export type GovernanceDenial = "invalid_config" | "enrollment_missing" | "revoked" | "approval_expired" | "eligibility_missing" |
  "eligibility_expired" | "source_mismatch" | "purpose_denied" | "data_denied" | "evidence_invalid" | "route_denied";
export type GovernanceDecision = { readonly allowed: true; readonly governed: boolean } | { readonly allowed: false; readonly reason: GovernanceDenial };

export interface GovernanceRequest {
  readonly tenant: string;
  readonly issuer: string;
  readonly requestId: string;
  readonly product: Product;
  readonly surface: string;
  readonly evaluationKind: EvaluationKind;
  readonly context: GovernanceContext | undefined;
  readonly gatewayId: string | undefined;
  readonly sourceRevision: string | undefined;
  readonly accountId: string | undefined;
  readonly workerName: string | undefined;
  readonly modelId: string;
  readonly now: number;
}

/** Called at each transfer, not just on configuration load or at primary-model selection. */
export function authorizeModelTransfer(config: GovernanceConfig | undefined, r: GovernanceRequest): GovernanceDecision {
  const deny = (reason: GovernanceDenial): GovernanceDecision => ({ allowed: false, reason });
  if (config === undefined) return deny("invalid_config");
  const e = Object.hasOwn(config.tenants, r.tenant) ? config.tenants[r.tenant] : undefined;
  if (e === undefined) return r.context === undefined ? { allowed: true, governed: false } : deny("enrollment_missing");
  if (e.revoked) return deny("revoked");
  if (!Number.isFinite(r.now) || r.now < e.approvedFrom || r.now >= e.approvedUntil) return deny("approval_expired");
  const c = r.context;
  if (c === undefined) return deny("eligibility_missing");
  // No skew allowance on eligibility: future or expired evidence is not current authority.
  if (r.now < c.issuedAt || r.now >= c.expiresAt || r.now - c.issuedAt > e.maxEligibilityAgeSeconds) return deny("eligibility_expired");
  if (!e.issuers.includes(r.issuer) || e.institutionId !== c.institutionId || c.requestId !== r.requestId ||
      e.product !== r.product || c.product !== r.product || c.surface !== r.surface || !e.surfaces.includes(r.surface) ||
      c.policyRevision !== e.policyRevision) return deny("source_mismatch");
  if (!e.purposes.some((p) => p.id === c.purpose && p.evaluationKinds.includes(r.evaluationKind))) return deny("purpose_denied");
  if (c.ageEligibility === "unknown" || c.ageEligibility === "ineligible" || !e.ageEligibility.includes(c.ageEligibility) ||
      !e.dataClasses.includes(c.dataClass) || (c.dataClass === "synthetic") !== (c.ageEligibility === "synthetic") ||
      (c.dataClass === "staff" && c.ageEligibility !== "adult")) return deny("data_denied");
  const a = Object.hasOwn(config.evidence, r.tenant) ? config.evidence[r.tenant] : undefined;
  if (a === undefined || a.result !== "verified" || r.now < a.checkedAt || r.now >= a.expiresAt ||
      a.institutionId !== e.institutionId || a.policyRevision !== e.policyRevision || a.approvalRef !== e.approvalRef || a.agreementRef !== e.agreementRef ||
      !a.dataClasses.includes(c.dataClass) || !a.ageEligibility.includes(c.ageEligibility) || !observationsAllow(a.route, a.observations)) return deny("evidence_invalid");
  const route = e.route;
  if (route.accountId !== a.route.accountId || route.workerName !== a.route.workerName || route.providerId !== a.route.providerId ||
      route.kind !== a.route.kind || route.gatewayId !== a.route.gatewayId || (r.gatewayId ?? null) !== route.gatewayId ||
      route.sourceRevision !== a.route.sourceRevision || route.sourceRevision !== r.sourceRevision ||
      route.accountId !== r.accountId || route.workerName !== r.workerName ||
      !route.modelIds.some((m) => m === r.modelId) || !a.route.modelIds.some((m) => m === r.modelId)) return deny("route_denied");
  return { allowed: true, governed: true };
}
