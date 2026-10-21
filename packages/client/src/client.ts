import {
  BatchEvaluationRequest,
  BatchEvaluationResponse,
  Capabilities,
  EvaluationRequest,
  EvaluationResult,
  OpaqueId,
  ReceiptRecord,
} from "@gmacko/hall-monitor-contracts";
import type { z } from "zod";
import { errorFromResponse, HallMonitorError, HallMonitorTimeoutError } from "./errors.ts";
import type { Transport } from "./transport.ts";

/** Default deadline for one client call, including its retries. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default number of retries after the first attempt. */
export const DEFAULT_RETRIES = 1;

/** Settings for {@link createHallMonitorClient}. */
export interface HallMonitorClientOptions {
  readonly transport: Transport;
  /** Deadline for each call, across all of its attempts. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt, for retryable failures only. Defaults to {@link DEFAULT_RETRIES}. */
  readonly retries?: number;
  /** Backoff bounds; each delay is drawn uniformly from `[0, min(maxMs, baseMs × 2^retry)]`. */
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number };
  /** Test seams for the backoff delay. */
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Per-call settings. */
export interface CallOptions {
  /** Aborts the call; the client rethrows the signal's reason. */
  readonly signal?: AbortSignal;
  /** Overrides the client's deadline for this call. */
  readonly timeoutMs?: number;
}

/** A typed client for the Hall Monitor HTTP API. */
export interface HallMonitorClient {
  /** Evaluates one request. Idempotent by `idempotencyKey`, so a retried call is never billed twice. */
  evaluate(request: EvaluationRequest, options?: CallOptions): Promise<EvaluationResult>;
  /** Evaluates up to 50 offline (`content.candidate` / `assessment.evaluator-result`) requests. */
  evaluateBatch(requests: readonly EvaluationRequest[], options?: CallOptions): Promise<BatchEvaluationResponse>;
  /** What the deployment supports, including the caller's policy profile revisions. */
  capabilities(options?: CallOptions): Promise<Capabilities>;
  /** The caller tenant's receipt record for an evaluation, or null when there is none. */
  receipt(evaluationId: string, options?: CallOptions): Promise<ReceiptRecord | null>;
}

interface Call<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /** Whether repeating the call is safe. Only idempotent calls are retried. */
  readonly idempotent: boolean;
  /** HTTP statuses that mean "no such resource" and resolve to null instead of throwing. */
  readonly nullOn?: number;
}

/**
 * Creates a client. Requests are validated before sending and responses against the wire
 * schemas after; failures surface as {@link HallMonitorError} (or {@link HallMonitorTimeoutError}).
 *
 * Retries apply only to idempotent calls and only on network errors, 429 and 5xx, with full-jitter
 * exponential backoff that honors `Retry-After`. Every call in this API is idempotent: evaluations
 * by their idempotency key (the service replays a stored result instead of re-evaluating), reads
 * trivially. The client never logs.
 */
export function createHallMonitorClient(options: HallMonitorClientOptions): HallMonitorClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be a non-negative integer");
  const baseMs = options.backoff?.baseMs ?? 100;
  const maxMs = options.backoff?.maxMs ?? 2_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;

  async function call<T>(spec: Call<T>, callOptions: CallOptions = {}): Promise<T | null> {
    const deadline = callOptions.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HallMonitorTimeoutError(deadline)), deadline);
    const parent = callOptions.signal;
    const onAbort = () => controller.abort(parent?.reason);
    if (parent?.aborted) onAbort();
    parent?.addEventListener("abort", onAbort, { once: true });
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    try {
      for (let attempt = 0; ; attempt++) {
        let failure: HallMonitorError;
        let retryAfterMs: number | undefined;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const response = await options.transport.send({
            method: spec.method,
            path: spec.path,
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
          });
          if (response.ok) return await parseBody(response, spec.schema);
          if (spec.nullOn === response.status) return null;
          failure = await errorFromResponse(response);
          retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof HallMonitorError) throw error;
          failure = new HallMonitorError({ code: "unavailable", message: "Hall Monitor could not be reached", retryable: true }, undefined, {
            cause: error,
          });
        }
        if (!spec.idempotent || attempt >= retries || !retriable(failure)) throw failure;
        const backoff = Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
        try {
          await sleep(Math.min(maxMs, Math.max(backoff, retryAfterMs ?? 0)), controller.signal);
        } catch {
          throw controller.signal.aborted ? controller.signal.reason : failure;
        }
      }
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  }

  const required = async <T>(spec: Call<T>, callOptions?: CallOptions): Promise<T> => (await call(spec, callOptions)) as T;

  return {
    async evaluate(request, callOptions) {
      const body = validate(EvaluationRequest, request);
      return required({ method: "POST", path: "/v1/evaluations", body, schema: EvaluationResult, idempotent: true }, callOptions);
    },
    async evaluateBatch(requests, callOptions) {
      const body = validate(BatchEvaluationRequest, { requests });
      return required(
        { method: "POST", path: "/v1/evaluations:batch", body, schema: BatchEvaluationResponse, idempotent: true },
        callOptions,
      );
    },
    async capabilities(callOptions) {
      return required({ method: "GET", path: "/v1/capabilities", schema: Capabilities, idempotent: true }, callOptions);
    },
    async receipt(evaluationId, callOptions) {
      const id = validate(OpaqueId, evaluationId);
      return call(
        { method: "GET", path: `/v1/receipts/${encodeURIComponent(id)}`, schema: ReceiptRecord, idempotent: true, nullOn: 404 },
        callOptions,
      );
    },
  };
}

/** Network errors, 429 and 5xx; never 4xx validation, auth or conflict errors. */
function retriable(error: HallMonitorError): boolean {
  if (error.status === undefined) return error.retryable;
  return error.status === 429 || error.status >= 500;
}

/** Validates an outgoing value, reporting field paths only, since values may be content. */
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
  throw new HallMonitorError({ code: "invalid_request", message: `invalid fields: ${fields.join(", ")}`, retryable: false });
}

async function parseBody<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HallMonitorError(
      { code: "unavailable", message: "Hall Monitor returned a response that does not match the wire schema", retryable: false },
      response.status,
    );
  }
  return parsed.data;
}

/** Reads `Retry-After` in delta-seconds; HTTP dates and nonsense are ignored. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
