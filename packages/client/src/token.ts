import type { TokenSource } from "./transport.ts";

/** Default token lifetime: long enough for one call and its retries' clock skew, no more. */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 60;

/** The longest lifetime Hall Monitor accepts (its `MAX_TOKEN_LIFETIME_SECONDS`). */
export const MAX_SERVICE_TOKEN_LIFETIME_SECONDS = 60 * 60;

/** A WebCrypto `CryptoKey`, typed structurally so the package needs no DOM or Node type library. */
export type SigningKey = Parameters<typeof crypto.subtle.sign>[1];

/** Settings for {@link serviceTokenSource}. */
export interface ServiceTokenOptions {
  /** The `iss` claim; must be an issuer the deployment trusts. */
  readonly issuer: string;
  /** The `aud` claim: the deployment's audience. */
  readonly audience: string | readonly string[];
  /** The tenant every request on these tokens acts for. */
  readonly tenant: string;
  /** Granted scopes, e.g. `["evaluate", "receipts:read"]`. */
  readonly scope: readonly string[];
  /** `EdDSA` for an Ed25519 key, `ES256` for a P-256 key. */
  readonly algorithm: "EdDSA" | "ES256";
  /** A WebCrypto private key with the `sign` usage, matching `algorithm`. */
  readonly privateKey: SigningKey;
  /** The `kid` header, naming the public key in the issuer's configured JWKS. */
  readonly keyId?: string;
  /** Token lifetime in seconds; defaults to {@link DEFAULT_TOKEN_LIFETIME_SECONDS}. */
  readonly lifetimeSeconds?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly newTokenId?: () => string;
}

/**
 * A {@link TokenSource} that signs a new service JWT on every call, each with its own `jti`.
 *
 * Hall Monitor accepts each token once and answers a replayed `jti` with `401 unauthorized`.
 * Transports call their token source once per HTTP attempt, so with this source every retry of an
 * idempotent call carries a fresh token. A custom token source must do the same: never cache or
 * reuse a token across calls.
 */
export function serviceTokenSource(options: ServiceTokenOptions): TokenSource {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > MAX_SERVICE_TOKEN_LIFETIME_SECONDS) {
    throw new RangeError(`lifetimeSeconds must be an integer from 1 to ${MAX_SERVICE_TOKEN_LIFETIME_SECONDS}`);
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const newTokenId = options.newTokenId ?? (() => crypto.randomUUID());
  const header = encodeJson({ alg: options.algorithm, typ: "JWT", ...(options.keyId === undefined ? {} : { kid: options.keyId }) });
  const params = options.algorithm === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };

  return async () => {
    const issuedAt = now();
    const claims = {
      iss: options.issuer,
      aud: typeof options.audience === "string" ? options.audience : [...options.audience],
      iat: issuedAt,
      exp: issuedAt + lifetime,
      jti: newTokenId(),
      tenant: options.tenant,
      scope: options.scope.join(" "),
    };
    const signingInput = `${header}.${encodeJson(claims)}`;
    // WebCrypto's ECDSA signature is the raw r || s form JWS uses, so it needs no conversion.
    const signature = await crypto.subtle.sign(params, options.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  };
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
