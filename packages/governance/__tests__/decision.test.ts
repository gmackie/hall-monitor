import { describe, expect, it } from "vitest";
import { authorizeModelTransfer, GovernanceConfig, GovernanceContext, parseGovernanceConfig } from "../src/index.ts";
import { config, context, NOW, request } from "./fixtures.ts";

describe("per-transfer governance", () => {
  it("allows the exact current synthetic enrollment and checks its escalation model separately", () => {
    const c = config(); expect(GovernanceConfig.safeParse(c).success).toBe(true);
    expect(GovernanceContext.safeParse(context()).success).toBe(true);
    expect(authorizeModelTransfer(c, request())).toEqual({ allowed: true, governed: true });
    c.tenants.tenant_synthetic!.route.modelIds = ["@cf/cloudflare/clef-flash"];
    expect(authorizeModelTransfer(c, request()).allowed).toBe(true);
    expect(authorizeModelTransfer(c, { ...request(), modelId: "@cf/cloudflare/clef" })).toEqual({ allowed: false, reason: "route_denied" });
  });

  it.each([
    ["no context", { context: undefined }, "eligibility_missing"],
    ["expired", { context: { ...context(), expiresAt: NOW } }, "eligibility_expired"],
    ["future", { context: { ...context(), issuedAt: NOW + 1 } }, "eligibility_expired"],
    ["old but unexpired", { context: { ...context(), issuedAt: NOW - 301 } }, "eligibility_expired"],
    ["issuer", { issuer: "https://other.test" }, "source_mismatch"],
    ["institution", { context: { ...context(), institutionId: "other" } }, "source_mismatch"],
    ["request", { context: { ...context(), requestId: "other" } }, "source_mismatch"],
    ["product", { product: "playtrek" as const }, "source_mismatch"],
    ["surface", { surface: "private.counseling" }, "source_mismatch"],
    ["policy", { context: { ...context(), policyRevision: "old" } }, "source_mismatch"],
    ["purpose", { context: { ...context(), purpose: "marketing" } }, "purpose_denied"],
    ["unknown age", { context: { ...context(), ageEligibility: "unknown" as const } }, "data_denied"],
    ["ineligible", { context: { ...context(), ageEligibility: "ineligible" as const } }, "data_denied"],
    ["under 13", { context: { ...context(), ageEligibility: "under-13" as const, dataClass: "student" as const } }, "data_denied"],
    ["student data", { context: { ...context(), dataClass: "student" as const } }, "data_denied"],
    ["account", { accountId: "c".repeat(32) }, "route_denied"],
    ["worker", { workerName: "another" }, "route_denied"],
    ["source revision", { sourceRevision: "c".repeat(40) }, "route_denied"],
    ["gateway drift", { gatewayId: "unexpected" }, "route_denied"],
  ] as const)("denies %s", (_label, override, reason) => {
    expect(authorizeModelTransfer(config(), { ...request(), ...override })).toEqual({ allowed: false, reason });
  });

  it.each(["revoked", "expired", "missing evidence", "stale evidence", "unverified evidence", "evidence tenant", "agreement", "logging", "logpush", "model cache"])("denies %s enrollment/evidence", (which) => {
    const c = config(), e = c.tenants.tenant_synthetic!, a = c.evidence.tenant_synthetic!;
    if (which === "revoked") e.revoked = true;
    if (which === "expired") e.approvedUntil = NOW;
    if (which === "missing evidence") delete c.evidence.tenant_synthetic;
    if (which === "stale evidence") a.expiresAt = NOW;
    if (which === "unverified evidence") a.result = "unverified";
    if (which === "evidence tenant") a.institutionId = "other";
    if (which === "agreement") a.agreementRef = "other";
    if (which === "logging") a.observations.workerObservability = "enabled";
    if (which === "logpush") a.observations.accountLogpush = "enabled";
    if (which === "model cache") a.observations.modelRetention = "unverified";
    expect(authorizeModelTransfer(c, request()).allowed).toBe(false);
  });

  it("does not turn a malformed explicit config into unenrolled bypass", () => {
    expect(authorizeModelTransfer(parseGovernanceConfig("{}"), request())).toEqual({ allowed: false, reason: "invalid_config" });
    expect(authorizeModelTransfer(parseGovernanceConfig(undefined), request())).toEqual({ allowed: true, governed: false });
  });

  it("requires governance extension keys and refuses birth dates and extra fields", () => {
    expect(GovernanceContext.safeParse({ ...context(), dateOfBirth: "2000-01-01" }).success).toBe(false);
    expect(GovernanceConfig.safeParse({ ...config(), allowUnverified: true }).success).toBe(false);
  });
});
