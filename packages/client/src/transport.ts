/** One HTTP call the client asks a transport to make. */
export interface TransportRequest {
  readonly method: "GET" | "POST";
  /** An absolute API path such as `/v1/evaluations`. */
  readonly path: string;
  /** A JSON body, already serialized. */
  readonly body?: string;
  readonly signal: AbortSignal;
}

/**
 * Carries client calls to a Hall Monitor deployment. A transport only moves bytes and attaches
 * credentials; validation, retries and timeouts belong to the client.
 */
export interface Transport {
  send(request: TransportRequest): Promise<Response>;
}

/** Supplies a short-lived bearer service token (a signed JWT) for each call. */
export type TokenSource = () => Promise<string>;

/** Settings for {@link fetchTransport}. */
export interface FetchTransportOptions {
  /** The deployment's origin, e.g. `https://hall-monitor.example.com`. Must be HTTPS except on loopback. */
  readonly baseUrl: string;
  readonly getToken: TokenSource;
  readonly fetch?: typeof fetch;
}

/** A transport over HTTPS, authenticating each call with a bearer service token. */
export function fetchTransport(options: FetchTransportOptions): Transport {
  const base = new URL(options.baseUrl);
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new TypeError("Hall Monitor baseUrl must use https");
  }
  const origin = base.href.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async send(request) {
      const token = await options.getToken();
      return fetchImpl(`${origin}${request.path}`, init(request, token));
    },
  };
}

/** The part of a Cloudflare service binding (`env.HALL_MONITOR`) the transport uses. */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/** The host name used for requests sent over a service binding; the binding ignores it. */
export const SERVICE_BINDING_ORIGIN = "https://hall-monitor.internal";

/**
 * A transport over a same-account Cloudflare service binding. It speaks the same HTTP API through
 * `binding.fetch`, so the Worker authenticates binding calls exactly as it does public ones; pass
 * `getToken` to attach a service token.
 */
export function serviceBindingTransport(binding: ServiceBinding, options: { readonly getToken?: TokenSource } = {}): Transport {
  return {
    async send(request) {
      const token = options.getToken === undefined ? undefined : await options.getToken();
      return binding.fetch(new Request(`${SERVICE_BINDING_ORIGIN}${request.path}`, init(request, token)));
    },
  };
}

function init(request: TransportRequest, token: string | undefined): RequestInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (request.body !== undefined) headers["content-type"] = "application/json";
  return {
    method: request.method,
    headers,
    signal: request.signal,
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}
