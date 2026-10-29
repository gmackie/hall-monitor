import type { GovernanceConfig, GovernanceContext, GovernanceRequest, Route } from "../src/index.ts";

export const NOW = 1_800_000_000;
export function route(): Route {
  return { providerId: "cloudflare-workers-ai", accountId: "a".repeat(32), workerName: "hall-monitor-synthetic",
    kind: "direct", gatewayId: null, sourceRevision: "b".repeat(40), modelIds: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"] };
}
export function context(): GovernanceContext {
  return { schemaVersion: "1.0", institutionId: "synthetic-institution", requestId: "req_synthetic", product: "other",
    surface: "synthetic.chat", purpose: "moderation", dataClass: "synthetic", ageEligibility: "synthetic",
    eligibilityRef: "synthetic-eligibility", policyRevision: "synthetic-policy-1", issuedAt: NOW - 1, expiresAt: NOW + 300 };
}
export function config(): GovernanceConfig {
  return { schemaVersion: "1.0", tenants: { tenant_synthetic: {
    institutionId: "synthetic-institution", issuers: ["https://synthetic.test/issuer"], product: "other", surfaces: ["synthetic.chat"],
    purposes: [{ id: "moderation", evaluationKinds: ["interaction.input", "interaction.output", "content.candidate", "assessment.evaluator-result"] }],
    dataClasses: ["synthetic"], ageEligibility: ["synthetic"], policyRevision: "synthetic-policy-1",
    approvalRef: "fictional-approval-not-for-use", agreementRef: "fictional-agreement-not-for-use", approvedFrom: NOW - 100,
    approvedUntil: NOW + 1000, maxEligibilityAgeSeconds: 300, revoked: false, route: route(),
  } }, evidence: { tenant_synthetic: {
    schemaVersion: "1.0", institutionId: "synthetic-institution", policyRevision: "synthetic-policy-1",
    approvalRef: "fictional-approval-not-for-use", agreementRef: "fictional-agreement-not-for-use", verifierRef: "synthetic-verifier",
    route: route(), dataClasses: ["synthetic"], ageEligibility: ["synthetic"], checkedAt: NOW - 10, expiresAt: NOW + 500,
    observations: { workerObservability: "disabled", accountLogpush: "disabled", gatewayLogs: "not_applicable",
      gatewayCache: "not_applicable", aiBinding: "matched", route: "matched", modelRetention: "approved" }, result: "verified",
  } } };
}
export function request(): GovernanceRequest {
  return { tenant: "tenant_synthetic", issuer: "https://synthetic.test/issuer", requestId: "req_synthetic", product: "other",
    surface: "synthetic.chat", evaluationKind: "interaction.input", context: context(), gatewayId: undefined,
    sourceRevision: route().sourceRevision, accountId: route().accountId, workerName: route().workerName,
    modelId: "@cf/cloudflare/clef-flash", now: NOW };
}
