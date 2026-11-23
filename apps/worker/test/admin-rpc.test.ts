import { createExecutionContext, env, SELF } from "cloudflare:test";
import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRpc, AdminRpcError, adminGet, adminList } from "../src/admin-rpc.ts";
import { fakeAi } from "./fake-ai.ts";
import { call, evaluationRequest } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const BASE = "https://hall-monitor.test";

beforeEach(() => {
  fakeAi.reset();
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

async function seed(tenant: string): Promise<string> {
  const request = evaluationRequest({ tenant });
  const response = await SELF.fetch(`${BASE}/v1/evaluations`, call("POST", await mintToken("educateos", { tenant }), request));
  expect(response.status).toBe(200);
  return EvaluationResult.parse(await response.json()).evaluationId;
}

describe("AdminRpc", () => {
  it("is not reachable over the public HTTP surface", async () => {
    for (const path of ["/AdminRpc", "/admin/v1/evaluations", "/v1/admin/evaluations", "/listEvaluations", "/getEvaluation"]) {
      const response = await SELF.fetch(`${BASE}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "invalid_request", message: "no such route" });
    }
  });

  it("reads and lists only the named tenant's records", async () => {
    const evaluationId = await seed("tenant_rpc_a");
    expect((await adminGet(env, "tenant_rpc_a", evaluationId))?.evaluationId).toBe(evaluationId);
    expect(await adminGet(env, "tenant_rpc_b", evaluationId)).toBeNull();
    const page = await adminList(env, "tenant_rpc_a", { limit: 10 });
    expect(page.items.map((item) => item.evaluationId)).toContain(evaluationId);
    expect((await adminList(env, "tenant_rpc_b", {})).items).toEqual([]);
  });

  it("rejects invalid tenants, ids and queries with content-free errors", async () => {
    await expect(adminGet(env, "bad tenant!", "eval_x")).rejects.toThrow(new AdminRpcError("invalid tenant"));
    await expect(adminGet(env, "tenant_rpc_a", "../x")).rejects.toThrow(new AdminRpcError("invalid evaluation id"));
    await expect(adminList(env, "tenant_rpc_a", { limit: 999 })).rejects.toThrow(new AdminRpcError("invalid query"));
    await expect(adminList(env, "tenant_rpc_a", { from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" })).rejects.toThrow("invalid query");
    await expect(adminList(env, "tenant_rpc_a", { cursor: "AAAA" })).rejects.toThrow("invalid query");
  });

  it("serves the same records through the entrypoint class", async () => {
    const evaluationId = await seed("tenant_rpc_c");
    const rpc = new AdminRpc(createExecutionContext(), env);
    expect((await rpc.getEvaluation("tenant_rpc_c", evaluationId))?.tenantId).toBe("tenant_rpc_c");
    expect(await rpc.getEvaluation("tenant_rpc_d", evaluationId)).toBeNull();
    expect((await rpc.listEvaluations("tenant_rpc_c", { limit: 5 })).items).toHaveLength(1);
  });
});
