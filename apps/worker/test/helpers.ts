import { env } from "cloudflare:test";
import type { EvaluationKind, EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import worker, { type Env } from "../src/index.ts";

/** Synthetic text that must never appear in any log line, response error or receipt. */
export const SENTINEL = "SENTINEL-SYNTHETIC-TEXT-7f3a";

/** A synthetic evaluation request for `tenant`. */
export function evaluationRequest(overrides: Partial<EvaluationRequest> & { tenant?: string; text?: string; kind?: EvaluationKind } = {}): EvaluationRequest {
  const { tenant = "tenant_educateos", text = `${SENTINEL} Why do leaves change colour in autumn?`, kind = "interaction.input", ...rest } = overrides;
  const id = crypto.randomUUID().slice(0, 8);
  return {
    schemaVersion: "1.0",
    requestId: `req_${id}`,
    idempotencyKey: `idem_${id}`,
    source: { product: "educateos", tenantId: tenant, surface: "student.chat" },
    policy: { profileId: "student-9-12", revision: "builtin-1" },
    context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_science" },
    evaluationKind: kind,
    content: { type: "text", text },
    ...rest,
  };
}

/** Request options for a JSON call with an optional bearer token. */
export function call(method: "GET" | "POST", token: string | undefined, body?: unknown): RequestInit {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

/**
 * Calls the real Worker directly with `env` plus `extra` bindings, bypassing test/entry.ts, for
 * cases that need a binding to be absent (AI) or replaced (rate limiter).
 */
export async function direct(path: string, init: RequestInit, extra: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(new Request(`https://hall-monitor.test${path}`, init), { ...env, ...extra });
}
