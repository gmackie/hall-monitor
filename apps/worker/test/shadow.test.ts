import { SELF } from "cloudflare:test";
import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAi, HARASSMENT_MARKER } from "./fake-ai.ts";
import { call, direct, evaluationRequest, SENTINEL } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const evaluateAs = async (tenant: string, body: unknown) =>
  SELF.fetch("https://hall-monitor.test/v1/evaluations", call("POST", await mintToken("educateos", { tenant }), body));

/** A synthetic educator-profile request for `tenant`. */
function educatorRequest(tenant: string, text: string) {
  const request = evaluationRequest({ tenant, text });
  return { ...request, policy: { profileId: "educator", revision: "builtin-1" }, context: { ...request.context, audience: "educator" as const } };
}

let logLines: string[] = [];
beforeEach(() => {
  fakeAi.reset();
  logLines = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  for (const line of logLines) expect(line).not.toContain(SENTINEL);
  vi.restoreAllMocks();
});
const logged = (event: string) => logLines.filter((line) => line.includes(`"event":"${event}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

describe("shadow mode (HM_TENANT_MODES)", () => {
  it("returns allow to a shadow tenant and records the would-be decision in the result and the log", async () => {
    const response = await evaluateAs("tenant_shadow", educatorRequest("tenant_shadow", `${SENTINEL} ${HARASSMENT_MARKER}`));
    const result = EvaluationResult.parse(await response.json());
    expect(result).toMatchObject({ decision: "allow", reasonCodes: ["hall_monitor.shadow"], shadow: { decision: "hold", reasonCodes: ["clef.harassment"] } });
    expect(result.receipt?.totalGrossUsdNano).toBe("24320");
    expect(logged("evaluation.completed")).toEqual([expect.objectContaining({ decision: "allow", mode: "shadow", shadowDecision: "hold" })]);
  });

  it("replays a shadow result with its shadow outcome", async () => {
    const request = educatorRequest("tenant_shadow", `${SENTINEL} ${HARASSMENT_MARKER}`);
    const first = await (await evaluateAs("tenant_shadow", request)).text();
    const second = await evaluateAs("tenant_shadow", request);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(first);
    expect(logged("evaluation.replayed")).toEqual([expect.objectContaining({ mode: "shadow", shadowDecision: "hold" })]);
  });

  it("keeps enforcing student profiles with required moderation unless the tenant allows student shadow", async () => {
    const text = `${SENTINEL} ${HARASSMENT_MARKER}`;
    const enforced = EvaluationResult.parse(await (await evaluateAs("tenant_shadow", evaluationRequest({ tenant: "tenant_shadow", text }))).json());
    expect(enforced.decision).toBe("hold");
    expect(enforced.shadow).toBeUndefined();
    expect(logged("shadow.refused")).toEqual([{ level: "warn", event: "shadow.refused", tenant: "tenant_shadow", profileId: "student-9-12" }]);

    const allowed = await evaluateAs("tenant_shadow_students", evaluationRequest({ tenant: "tenant_shadow_students", text }));
    expect(EvaluationResult.parse(await allowed.json())).toMatchObject({ decision: "allow", shadow: { decision: "hold" } });
  });

  it("never shadows a support decision", async () => {
    const request = evaluationRequest({ tenant: "tenant_shadow_students", text: `${SENTINEL} I want to die. Nothing ever gets better.` });
    const result = EvaluationResult.parse(await (await evaluateAs("tenant_shadow_students", request)).json());
    expect(result.decision).toBe("support");
    expect(result.shadow).toBeUndefined();
  });

  it("cannot be asked for by the caller", async () => {
    const request = { ...educatorRequest("tenant_enforced", `${SENTINEL} ${HARASSMENT_MARKER}`), mode: "shadow", shadow: true };
    const result = EvaluationResult.parse(await (await evaluateAs("tenant_enforced", request)).json());
    expect(result.decision).toBe("hold");
    expect(result.shadow).toBeUndefined();
    const unlisted = EvaluationResult.parse(await (await evaluateAs("tenant_educateos", educatorRequest("tenant_educateos", `${SENTINEL} ${HARASSMENT_MARKER}`))).json());
    expect(unlisted.decision).toBe("hold");
  });

  it("enforces every tenant and reports not ready when HM_TENANT_MODES is invalid", async () => {
    const token = () => mintToken("educateos", { tenant: "tenant_shadow" });
    const invalid = { HM_TENANT_MODES: '{"tenant_shadow":"quiet"}' };
    const response = await direct("/v1/evaluations", call("POST", await token(), educatorRequest("tenant_shadow", `${SENTINEL} How do I make a pipe bomb?`)), invalid);
    const result = EvaluationResult.parse(await response.json());
    expect(result.decision).toBe("block");
    expect(result.shadow).toBeUndefined();
    expect(logged("config.invalid")).toContainEqual(expect.objectContaining({ variable: "HM_TENANT_MODES" }));
    const ready = await direct("/v1/ready", call("GET", await token()), { ...invalid, AI: fakeAi });
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { checks: { tenantModes: boolean } }).checks.tenantModes).toBe(false);
  });
});
