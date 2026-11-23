import type { Env, EvaluatorRpc } from "./env.ts";
import type { Principal } from "./roles.ts";

/** Everything a route handler receives. */
export interface Ctx {
  readonly request: Request;
  readonly url: URL;
  readonly env: Env;
  readonly principal: Principal;
  readonly evaluator: EvaluatorRpc | undefined;
  /** Decoded path parameters, in order. */
  readonly params: readonly string[];
}

export type Handler = (ctx: Ctx) => Promise<Response>;

export interface Route {
  readonly method: "GET" | "POST" | "PUT";
  /** Matched against the path after `/admin/v1`; capture groups become `params`. */
  readonly path: RegExp;
  readonly handler: Handler;
}

/** One path segment: an opaque id or a tenant name, never a slash. */
export const SEG = "([^/]+)";

export function route(method: Route["method"], pattern: string, handler: Handler): Route {
  return { method, path: new RegExp(`^${pattern}$`), handler };
}
