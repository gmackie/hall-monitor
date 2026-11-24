/** A content-free API error: a fixed code and message, never request content. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = "not found") => new ApiError(404, "not_found", what);
export const forbidden = () => new ApiError(403, "forbidden", "this role does not allow that");
export const invalid = (message: string) => new ApiError(400, "invalid_request", message);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export function errorResponse(error: ApiError): Response {
  return json({ code: error.code, message: error.message }, error.status);
}

/** Largest JSON body the admin API accepts (a label-set import can carry a study). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new ApiError(413, "invalid_request", "body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ApiError(413, "invalid_request", "body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("body must be JSON");
  }
}

/** A path segment, decoded; anything that does not decode is a 400. */
export function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw invalid("invalid path");
  }
}
