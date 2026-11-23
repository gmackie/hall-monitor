import { type EvaluationRecord, OpaqueId, parseEvaluationQuery } from "@gmacko/hall-monitor-contracts";
import type { EvaluatorRpc } from "../env.ts";
import { ApiError, invalid, json, notFound, segment } from "../http.ts";
import { hasRole, requireRole, viewableTenants } from "../roles.ts";
import { type Ctx, route, SEG } from "../router.ts";

function evaluatorOf(ctx: Ctx): EvaluatorRpc {
  if (ctx.evaluator === undefined) throw new ApiError(503, "unavailable", "the evaluation Worker is not bound");
  return ctx.evaluator;
}

function tenantParam(ctx: Ctx, index = 0): string {
  const tenant = segment(ctx.params[index]!);
  if (!OpaqueId.safeParse(tenant).success) throw invalid("invalid tenant");
  return tenant;
}

function evaluationIdParam(raw: string): string {
  const id = segment(raw);
  if (!OpaqueId.safeParse(id).success) throw invalid("invalid evaluation id");
  return id;
}

/** Maps an RPC failure: the AdminRpc's fixed "invalid …" messages are 400s, anything else 503. */
async function rpc<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^invalid (query|tenant|evaluation id)$/.test(message)) throw invalid(message);
    throw new ApiError(503, "unavailable", "the evaluation Worker is unavailable");
  }
}

/**
 * Finds an evaluation by id across every tenant the person can view, in parallel, and returns the
 * first match in tenant order. A miss is a plain 404 that never says which tenants exist.
 */
export async function findEvaluation(ctx: Ctx, evaluationId: string, tenant: string | null): Promise<{ tenant: string; record: EvaluationRecord }> {
  const evaluator = evaluatorOf(ctx);
  if (tenant !== null) {
    // An unviewable tenant is indistinguishable from a missing record.
    if (!OpaqueId.safeParse(tenant).success || !hasRole(ctx.principal, tenant, "viewer")) throw notFound("evaluation not found");
    const record = await rpc(() => evaluator.getEvaluation(tenant, evaluationId));
    if (record === null) throw notFound("evaluation not found");
    return { tenant, record };
  }
  const tenants = await viewableTenants(ctx.env, ctx.principal);
  const found = await Promise.all(tenants.map((candidate) => rpc(() => evaluator.getEvaluation(candidate, evaluationId)).catch(() => null)));
  const index = found.findIndex((record) => record !== null);
  if (index < 0) throw notFound("evaluation not found");
  return { tenant: tenants[index]!, record: found[index]! };
}

export const evaluationRoutes = [
  /** The evaluation explorer: one page of a tenant's records, filtered as `GET /v1/evaluations` is. */
  route("GET", `/tenants/${SEG}/evaluations`, async (ctx) => {
    const tenant = tenantParam(ctx);
    requireRole(ctx.principal, tenant, "viewer");
    const parsed = parseEvaluationQuery(ctx.url.searchParams);
    if (!parsed.ok) throw invalid(`invalid query parameters: ${parsed.fields.join(", ")}`);
    const evaluator = evaluatorOf(ctx);
    return json(await rpc(() => evaluator.listEvaluations(tenant, parsed.query)));
  }),
  route("GET", `/tenants/${SEG}/evaluations/${SEG}`, async (ctx) => {
    const tenant = tenantParam(ctx);
    requireRole(ctx.principal, tenant, "viewer");
    const evaluationId = evaluationIdParam(ctx.params[1]!);
    const evaluator = evaluatorOf(ctx);
    const record = await rpc(() => evaluator.getEvaluation(tenant, evaluationId));
    if (record === null) throw notFound("evaluation not found");
    return json({ tenant, record });
  }),
  /**
   * The deep link products use (`<console>/evaluations/<id>`): without `?tenant=` it searches
   * every tenant the person can view; with it, only that tenant.
   */
  route("GET", `/evaluations/${SEG}`, async (ctx) => {
    const evaluationId = evaluationIdParam(ctx.params[0]!);
    return json(await findEvaluation(ctx, evaluationId, ctx.url.searchParams.get("tenant")));
  }),
];
