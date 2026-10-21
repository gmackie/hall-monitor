import { ErrorBody, type ErrorCode } from "@gmacko/hall-monitor-contracts";

/**
 * A failed Hall Monitor call. `body` is the service's wire error (or one synthesized from the
 * HTTP status when the service sent none); messages never quote request content.
 */
export class HallMonitorError extends Error {
  override readonly name: string = "HallMonitorError";
  /** The wire form of this error. */
  readonly body: ErrorBody;
  /** The HTTP status, when the service answered at all. */
  readonly status: number | undefined;

  /** Creates an error from a wire body and the HTTP status that carried it. */
  constructor(body: ErrorBody, status?: number, options?: { cause?: unknown }) {
    super(body.message, options);
    this.body = body;
    this.status = status;
  }

  /** The machine-readable error code. */
  get code(): ErrorCode {
    return this.body.code;
  }

  /** Whether the same call may succeed if repeated later. */
  get retryable(): boolean {
    return this.body.retryable;
  }
}

/** A call that did not finish within its deadline. Retrying an idempotent call is safe. */
export class HallMonitorTimeoutError extends HallMonitorError {
  override readonly name: string = "HallMonitorTimeoutError";

  /** Creates a timeout error for a deadline of `timeoutMs`. */
  constructor(readonly timeoutMs: number) {
    super({ code: "unavailable", message: `Hall Monitor call exceeded ${timeoutMs}ms`, retryable: true });
  }
}

/** The error code a bare HTTP status implies when the response carried no error body. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 409:
      return "idempotency_conflict";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "invalid_request";
  }
}

/** Reads a wire error from a failed response, synthesizing one from the status if needed. */
export async function errorFromResponse(response: Response): Promise<HallMonitorError> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const body = ErrorBody.safeParse(parsed);
  if (body.success) return new HallMonitorError(body.data, response.status);
  return new HallMonitorError(
    {
      code: codeForStatus(response.status),
      message: `Hall Monitor returned HTTP ${response.status}`,
      retryable: response.status === 429 || response.status >= 500,
    },
    response.status,
  );
}
