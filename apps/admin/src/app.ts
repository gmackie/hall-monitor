import { AccessError, accessSettings, AccessUnconfigured, fetchAccessJwks, type JwksSource, verifyAccessToken } from "./access.ts";
import { adminRoutes } from "./api/admin.ts";
import { evaluationRoutes } from "./api/evaluations.ts";
import { labelRoutes } from "./api/labels.ts";
import { meRoutes } from "./api/me.ts";
import { modelRoutes } from "./api/models.ts";
import { profileWriteRoutes } from "./api/profile-writes.ts";
import { profileReadRoutes } from "./api/profiles.ts";
import { releaseRoutes } from "./api/releases.ts";
import type { Env, EvaluatorRpc } from "./env.ts";
import { ApiError, errorResponse, json } from "./http.ts";
import { loadPrincipal } from "./roles.ts";
import type { Route } from "./router.ts";

/** The prefix every API route lives under; everything else is the SPA. */
export const API_PREFIX = "/admin/v1";

/** Seams for tests: where Access keys come from and which evaluator RPC is used. */
export interface AdminDeps {
  readonly jwks?: JwksSource;
  readonly evaluator?: (env: Env) => EvaluatorRpc | undefined;
  readonly now?: () => number;
}

export const ROUTES: readonly Route[] = [
  ...meRoutes, ...modelRoutes, ...profileReadRoutes, ...evaluationRoutes, ...adminRoutes,
  // HM-34: writes.
  ...profileWriteRoutes, ...releaseRoutes, ...labelRoutes,
];

/** Builds the admin Worker's fetch handler. */
export function createAdminApp(deps: AdminDeps = {}, routes: readonly Route[] = ROUTES) {
  const jwks = deps.jwks ?? fetchAccessJwks;
  return async function fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      if (env.ASSETS === undefined) return json({ code: "not_found", message: "not found" }, 404);
      return env.ASSETS.fetch(request);
    }
    const path = url.pathname.slice(API_PREFIX.length);
    try {
      let settings: { teamDomain: string; audience: string };
      try {
        settings = accessSettings(env);
      } catch (error) {
        if (error instanceof AccessUnconfigured) throw new ApiError(503, "unavailable", "access is not configured");
        throw error;
      }
      const token = request.headers.get("cf-access-jwt-assertion");
      let identity;
      try {
        const keys = await jwks(env, settings.teamDomain);
        identity = await verifyAccessToken(token, { ...settings, keys, now: Math.floor((deps.now?.() ?? Date.now()) / 1000) });
      } catch (error) {
        if (error instanceof AccessError) {
          console.log(JSON.stringify({ level: "info", event: "admin.auth_rejected", reason: error.reason }));
          throw new ApiError(401, "unauthorized", "a valid Cloudflare Access session is required");
        }
        throw new ApiError(503, "unavailable", "access keys are unavailable");
      }
      const principal = await loadPrincipal(env, identity.email);

      let methodMismatch = false;
      for (const candidate of routes) {
        const match = candidate.path.exec(path);
        if (match === null) continue;
        if (candidate.method !== request.method) {
          methodMismatch = true;
          continue;
        }
        return await candidate.handler({
          request, url, env, principal,
          evaluator: deps.evaluator !== undefined ? deps.evaluator(env) : env.EVALUATOR,
          params: match.slice(1),
        });
      }
      throw methodMismatch ? new ApiError(405, "invalid_request", "method not allowed") : new ApiError(404, "not_found", "no such route");
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      console.error(JSON.stringify({ level: "error", event: "admin.internal_error", errorName: error instanceof Error ? error.name.slice(0, 64) : typeof error }));
      return errorResponse(new ApiError(500, "internal", "internal error"));
    }
  };
}
