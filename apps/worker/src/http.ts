import type { ErrorBody, ErrorCode } from "@gmacko/hall-monitor-contracts";

/** The HTTP status each wire error code is sent with. */
export const STATUS_FOR_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  unsupported_schema: 400,
  policy_not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  idempotency_conflict: 409,
});

/** A failure to answer with a wire error. Messages are content-free by construction at every throw site. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  /** The wire body. */
  readonly body: ErrorBody;

  /** Creates an error; `status` defaults to the code's usual status. */
  constructor(
    code: ErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly status?: number; readonly headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.body = { code, message, retryable: options.retryable ?? false };
    this.status = options.status ?? STATUS_FOR_CODE[code];
    this.headers = options.headers ?? {};
  }

  /** The HTTP status. */
  readonly status: number;
  /** Extra response headers, such as `retry-after`. */
  readonly headers: Record<string, string>;
}

const BASE_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** A JSON response that is never cached. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** The response for a wire error. */
export function errorResponse(error: HttpError): Response {
  const headers: Record<string, string> = { ...error.headers };
  if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="hall-monitor"';
  return json(error.body, error.status, headers);
}

/**
 * Reads a JSON body of at most `maxBytes`. Parse errors are reported without echoing the body,
 * since it may be content.
 */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError("invalid_request", `body exceeds ${maxBytes} bytes`, { status: 413 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new HttpError("invalid_request", `body exceeds ${maxBytes} bytes`, { status: 413 });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError("invalid_request", "body is not valid UTF-8 JSON");
  }
}
