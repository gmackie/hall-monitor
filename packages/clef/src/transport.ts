import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { type ClefUsage, extractClefUsage } from "./clef-protocol.ts";

/** One model call's result, with whatever usage and correlation ids the provider returned. */
export interface ClefTransportResult {
  readonly output: unknown;
  readonly usage?: ClefUsage;
  readonly providerRequestId?: string;
  readonly gatewayLogId?: string;
}

/** Sends one Clef request. Implementations throw {@link ClefTransportError} on provider failure. */
export interface ClefTransport {
  run(model: string, input: unknown, options: { readonly signal: AbortSignal }): Promise<ClefTransportResult>;
}

/** Why a provider call failed. */
export type ClefFailureKind = "rate_limited" | "unavailable" | "rejected";

/** A provider failure. The message carries the status only, never request content. */
export class ClefTransportError extends Error {
  override readonly name = "ClefTransportError";

  /** Creates an error of the given kind with an optional HTTP status. */
  constructor(
    readonly kind: ClefFailureKind,
    readonly status?: number,
  ) {
    super(status === undefined ? `Clef request failed: ${kind}` : `Clef request failed: ${kind} (HTTP ${status})`);
  }
}

/** Maps an HTTP status to a failure kind: 429 is rate limiting, 5xx unavailability, other 4xx a rejection. */
export function failureKindForStatus(status: number): ClefFailureKind {
  if (status === 429) return "rate_limited";
  return status >= 500 ? "unavailable" : "rejected";
}

/**
 * Header that tells AI Gateway not to store request and response bodies in its logs
 * (`cf-aig-collect-log-payload: false`, per Cloudflare's AI Gateway logging docs). Usage metadata
 * is still logged. The name is configurable in case the documented header changes.
 */
export const DEFAULT_PAYLOAD_LOGGING_HEADER = "cf-aig-collect-log-payload";

/** AI Gateway settings shared by both transports. */
export interface GatewayOptions {
  /** Opaque, content-free metadata (tenant, product, purpose); at most five entries. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Store bodies in gateway logs. Defaults to false; student content must not be retained. */
  readonly collectLogPayload?: boolean;
  /** Explicitly disable the whole ordinary Gateway log for a governed route. */
  readonly collectLog?: boolean;
  /** Bypass Gateway response cache for a governed request. Configuration evidence is still required. */
  readonly skipCache?: boolean;
  /** Override for {@link DEFAULT_PAYLOAD_LOGGING_HEADER}. */
  readonly payloadLoggingHeader?: string;
}

/** The subset of the Workers AI binding (`env.AI`) the transport uses. */
export interface WorkersAiBinding {
  run(model: string, inputs: unknown, options?: Record<string, unknown>): Promise<unknown>;
  /** Set by the binding after a gateway-routed run, where supported. */
  readonly aiGatewayLogId?: string | null;
}

/**
 * A transport over the Workers AI binding, optionally routed through an AI Gateway. Gateway
 * options are passed as the binding's `gateway` run option, and the payload-logging header as an
 * extra header. Check both option names against the current binding docs when upgrading.
 */
export function workersAiBindingTransport(ai: WorkersAiBinding, gateway?: GatewayOptions & { readonly id: string }): ClefTransport {
  return {
    async run(model, input, { signal }) {
      const options: Record<string, unknown> = { signal };
      if (gateway !== undefined) {
        options.gateway = { id: gateway.id, ...(gateway.metadata === undefined ? {} : { metadata: gateway.metadata }) };
        options.extraHeaders = payloadHeaders(gateway);
      }
      let output: unknown;
      try {
        output = await ai.run(model, input, options);
      } catch (error) {
        throw new ClefTransportError(bindingFailureKind(error), statusOf(error));
      }
      return withIds({ output, usage: extractClefUsage(output) }, undefined, ai.aiGatewayLogId ?? undefined);
    },
  };
}

/** Settings for {@link gatewayFetchTransport}. */
export interface GatewayFetchOptions extends GatewayOptions {
  readonly accountId: string;
  readonly gatewayId: string;
  /** A Workers AI API token. */
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * A transport over AI Gateway's HTTP endpoint for Workers AI, for callers without a binding (for
 * example, a Hall Monitor in another account). Responses wrap the model output in `result`.
 */
export function gatewayFetchTransport(options: GatewayFetchOptions): ClefTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://gateway.ai.cloudflare.com/v1";
  return {
    async run(model, input, { signal }) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...payloadHeaders(options),
      };
      if (options.metadata !== undefined) headers["cf-aig-metadata"] = JSON.stringify(options.metadata);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/${options.accountId}/${options.gatewayId}/workers-ai/${model}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal,
        });
      } catch {
        throw new ClefTransportError("unavailable");
      }
      if (!response.ok) throw new ClefTransportError(failureKindForStatus(response.status), response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const output = isRecord(body) && "result" in body ? body.result : body;
      return withIds(
        { output, usage: extractClefUsage(output) },
        response.headers.get("cf-ray") ?? undefined,
        response.headers.get("cf-aig-log-id") ?? undefined,
      );
    },
  };
}

function payloadHeaders(options: GatewayOptions): Record<string, string> {
  return {
    [options.payloadLoggingHeader ?? DEFAULT_PAYLOAD_LOGGING_HEADER]: String(options.collectLogPayload ?? false),
    ...(options.collectLog === undefined ? {} : { "cf-aig-collect-log": String(options.collectLog) }),
    ...(options.skipCache === undefined ? {} : { "cf-aig-skip-cache": String(options.skipCache) }),
  };
}

/** Attaches correlation ids that are safe opaque identifiers; anything else is dropped. */
function withIds(
  result: { output: unknown; usage: ClefUsage | undefined },
  providerRequestId: string | undefined,
  gatewayLogId: string | undefined,
): ClefTransportResult {
  return {
    output: result.output,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(OpaqueId.safeParse(providerRequestId).success ? { providerRequestId: providerRequestId! } : {}),
    ...(OpaqueId.safeParse(gatewayLogId).success ? { gatewayLogId: gatewayLogId! } : {}),
  };
}

function bindingFailureKind(error: unknown): ClefFailureKind {
  const status = statusOf(error);
  if (status !== undefined) return failureKindForStatus(status);
  return error instanceof Error && /\b(429|rate limit|too many requests)\b/i.test(error.message) ? "rate_limited" : "unavailable";
}

function statusOf(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
