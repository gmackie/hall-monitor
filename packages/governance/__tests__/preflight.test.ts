import { describe, expect, it } from "vitest";
import { cloudflarePrivacyInspector, runPrivacyPreflight } from "../src/index.ts";
import { config, NOW, route } from "./fixtures.ts";

const input = () => ({ enrollment: config().tenants.tenant_synthetic!, verifierRef: "synthetic-verifier", evidenceExpiresAt: NOW + 200, providerRetention: "approved" });
function inspection(overrides: Record<string, unknown> = {}, gateway = false) {
  const paths: string[] = [];
  const worker = { observability: { enabled: false }, logpush: false, tail_consumers: [], bindings: [
    { type: "ai", name: "AI" }, { type: "plain_text", name: "FG_COMMIT_HASH", text: route().sourceRevision },
    ...(gateway ? [{ type: "plain_text", name: "HM_AI_GATEWAY_ID", text: "synthetic-gateway" }] : []),
  ] };
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const kind = path.endsWith("/settings") ? "worker" : path.endsWith("/jobs") ? "jobs" : "gateway";
    const body = kind in overrides ? overrides[kind] : kind === "worker" ? worker : kind === "jobs" ? [] : { collect_logs: false, logpush: false, cache_ttl: 0 };
    if (body === "denied") return new Response("DO-NOT-ECHO-PROVIDER-ERROR", { status: 403 });
    return Response.json({ success: true, result: body });
  };
  return { inspector: cloudflarePrivacyInspector("DO-NOT-ECHO-SECRET", fetchImpl), paths, worker };
}

describe("read-only provider preflight", () => {
  it("matches explicit direct-route settings and human approval references without inference", async () => {
    const { inspector, paths } = inspection();
    const report = await runPrivacyPreflight(input(), inspector, NOW);
    expect(report.result).toBe("verified");
    expect(report.attestation?.expiresAt).toBe(NOW + 200);
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.includes("/workers/scripts/") || p.endsWith("/logpush/jobs"))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/DO-NOT-ECHO|authorization|destination_conf/);
  });

  it.each([
    ["worker permission", { worker: "denied" }], ["export permission", { jobs: "denied" }],
    ["missing export flag", { jobs: [{}] }], ["unknown settings", { worker: {} }],
    ["independent enabled export", { jobs: [{ enabled: true, destination_conf: "DO-NOT-ECHO-DESTINATION" }] }],
  ])("cannot verify %s", async (_label, overrides) => {
    const report = await runPrivacyPreflight(input(), inspection(overrides).inspector, NOW);
    expect(report.result).not.toBe("verified");
    expect(JSON.stringify(report)).not.toContain("DO-NOT-ECHO");
  });

  it.each(["observability", "tail", "binding", "revision", "unexpected gateway", "missing logpush flag"])("declines worker %s drift", async (which) => {
    const fixture = inspection(); const worker = fixture.worker;
    if (which === "observability") worker.observability.enabled = true;
    if (which === "tail") (worker.tail_consumers as unknown[]).push({ service: "unreviewed" });
    if (which === "binding") worker.bindings = [];
    if (which === "revision") worker.bindings[1]!.text = "c".repeat(40);
    if (which === "unexpected gateway") worker.bindings.push({ type: "plain_text", name: "HM_AI_GATEWAY_ID", text: "unexpected" });
    if (which === "missing logpush flag") delete (worker as { logpush?: boolean }).logpush;
    expect((await runPrivacyPreflight(input(), inspection({ worker }).inspector, NOW)).result).not.toBe("verified");
  });

  it("inspects gateway logging, independent export and cache separately", async () => {
    const approval = input(); approval.enrollment.route = { ...route(), kind: "gateway", gatewayId: "synthetic-gateway" };
    const good = inspection({}, true);
    expect((await runPrivacyPreflight(approval, good.inspector, NOW)).result).toBe("verified");
    expect(good.paths).toHaveLength(3);
    for (const gateway of [
      { collect_logs: true, logpush: false, cache_ttl: 0 },
      { collect_logs: false, logpush: true, cache_ttl: 0 },
      { collect_logs: false, logpush: false, cache_ttl: 300 },
      { collect_logs: false, logpush: false, cache_ttl: null },
    ]) expect((await runPrivacyPreflight(approval, inspection({ gateway }, true).inspector, NOW)).result).not.toBe("verified");
  });

  it("unknown provider retention or expired approval cannot become verified", async () => {
    expect((await runPrivacyPreflight({ ...input(), providerRetention: "unverified" }, inspection().inspector, NOW)).result).toBe("unverified");
    const fixture = inspection();
    expect((await runPrivacyPreflight(input(), fixture.inspector, NOW + 200)).reason).toBe("approval_inactive");
    expect(fixture.paths).toHaveLength(0);
    expect((await runPrivacyPreflight({}, fixture.inspector, NOW)).reason).toBe("approval_invalid");
  });

  it("does not serialize unexpected fields from an inspection adapter", async () => {
    const observations = config().evidence.tenant_synthetic!.observations;
    const report = await runPrivacyPreflight(input(), { inspect: async () => ({ ...observations, token: "DO-NOT-ECHO-SECRET" }) }, NOW);
    expect(report.result).toBe("unverified");
    expect(JSON.stringify(report)).not.toContain("DO-NOT-ECHO");
  });
});
