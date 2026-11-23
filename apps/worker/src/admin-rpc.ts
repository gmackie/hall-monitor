import { WorkerEntrypoint } from "cloudflare:workers";
import { type EvaluationPage, EvaluationQuery, type EvaluationRecord, OpaqueId } from "@gmacko/hall-monitor-contracts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { storeFor } from "./tenant-store.ts";

/**
 * Raised for invalid arguments. The message is fixed and never echoes the argument, because it
 * crosses the service binding into the admin Worker's logs.
 */
export class AdminRpcError extends Error {
  override readonly name = "AdminRpcError";
}

/**
 * One page of `tenant`'s retained, content-free evaluation records, exactly as
 * `GET /v1/evaluations` returns them to that tenant's own service token.
 */
export async function adminList(env: Pick<Env, "IDEMPOTENCY_STORE">, tenant: unknown, query: unknown): Promise<EvaluationPage> {
  const id = tenantOf(tenant);
  const parsed = EvaluationQuery.safeParse(query ?? {});
  if (!parsed.success) throw new AdminRpcError("invalid query");
  const { from, to } = parsed.data;
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) throw new AdminRpcError("invalid query");
  const page = await storeFor(env, id).listEvaluations(parsed.data);
  if (page === null) throw new AdminRpcError("invalid query");
  log("info", "evaluation.listed", { tenant: id, items: page.items.length, route: "admin-rpc" });
  return page;
}

/** One of `tenant`'s evaluation records, or null when it is unknown, expired or another tenant's. */
export async function adminGet(env: Pick<Env, "IDEMPOTENCY_STORE">, tenant: unknown, evaluationId: unknown): Promise<EvaluationRecord | null> {
  const id = tenantOf(tenant);
  if (!OpaqueId.safeParse(evaluationId).success) throw new AdminRpcError("invalid evaluation id");
  const record = await storeFor(env, id).evaluation(evaluationId as string);
  if (record !== null) log("info", "evaluation.read", { tenant: id, evaluationId: evaluationId as string, route: "admin-rpc" });
  return record;
}

function tenantOf(tenant: unknown): string {
  if (!OpaqueId.safeParse(tenant).success) throw new AdminRpcError("invalid tenant");
  return tenant as string;
}

/**
 * The Hall Monitor admin Worker's read path into tenant evaluation records (HM-33). It is a named
 * `WorkerEntrypoint`, so it is reachable only through a service binding that names
 * `entrypoint: "AdminRpc"`; the public hostname serves only the default export's HTTP routes,
 * which have no admin route. The caller (the admin Worker) authorizes the person and the tenant;
 * this class trusts the binding and only validates its arguments.
 */
export class AdminRpc extends WorkerEntrypoint<Env> {
  async listEvaluations(tenant: string, query: EvaluationQuery): Promise<EvaluationPage> {
    return adminList(this.env, tenant, query);
  }

  async getEvaluation(tenant: string, evaluationId: string): Promise<EvaluationRecord | null> {
    return adminGet(this.env, tenant, evaluationId);
  }
}
