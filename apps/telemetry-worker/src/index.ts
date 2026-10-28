import {
  TELEMETRY_PATH, TENANT_HEADER,
  grantAllowsBatch, parseTelemetryTenants,
} from "@gmacko/hall-monitor-telemetry-contracts";
import { verifyTelemetryRequest } from "@gmacko/hall-monitor-telemetry-sink";

export interface TelemetryEnv {
  readonly HM_TELEMETRY_ACCEPT?: string;
  readonly HM_TELEMETRY_TENANTS?: string;
}

function reply(status: number, code: string, accepted?: number): Response {
  // Only fixed machine codes and counts; no body, student data or error messages in response.
  return new Response(JSON.stringify({
    code, ...(accepted === undefined ? {} : { accepted, persisted: false }),
  }), {
    status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * An authenticated *validate-and-discard* T1 receiver for service bindings.
 * No event data is logged, persisted, forwarded or exported. Public access is
 * separately prohibited in wrangler.jsonc (workers_dev=false and no routes).
 * Tenant-specific HMAC prevents unauthenticated injection if deployed wrongly.
 */
export async function handleTelemetry(request: Request, env: TelemetryEnv): Promise<Response> {
  if (new URL(request.url).pathname !== TELEMETRY_PATH) return reply(404, "not_found");
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  if (env.HM_TELEMETRY_ACCEPT !== "validate_only") return reply(503, "disabled");
  const grants = parseTelemetryTenants(env.HM_TELEMETRY_TENANTS);
  if (grants === null) return reply(503, "invalid_configuration");
  const tenant = request.headers.get(TENANT_HEADER);
  if (tenant === null) return reply(401, "unauthorized");
  const grant = grants.get(tenant);
  if (grant === undefined) return reply(403, "forbidden");
  try {
    const verified = await verifyTelemetryRequest(request, grant.signingKey);
    if (verified.tenant !== tenant || !grantAllowsBatch(grant, verified.batch)) return reply(403, "forbidden");
    return reply(202, "validated_not_persisted", verified.batch.events.length);
  } catch {
    // Intentionally indistinguishable for bad signature, malformed content and
    // invalid fields, to avoid reflecting private data or validation internals.
    return reply(401, "unauthorized");
  }
}

export default {
  fetch(request: Request, env: TelemetryEnv): Promise<Response> {
    return handleTelemetry(request, env);
  },
} satisfies ExportedHandler<TelemetryEnv>;
