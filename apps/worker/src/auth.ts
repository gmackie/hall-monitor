import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

/** Allowed clock skew, in seconds, when checking `exp`, `nbf` and `iat`. */
export const CLOCK_SKEW_SECONDS = 60;

/** The longest bearer token accepted, in characters. */
export const MAX_TOKEN_LENGTH = 8192;

/** Scope required to submit evaluations. */
export const SCOPE_EVALUATE = "evaluate";
/** Scope required to read receipts. */
export const SCOPE_RECEIPTS_READ = "receipts:read";

const Jwk = z
  .object({
    kty: z.enum(["OKP", "EC"]),
    crv: z.enum(["Ed25519", "P-256"]),
    x: z.string().min(1).max(256),
    y: z.string().min(1).max(256).optional(),
    kid: z.string().min(1).max(256).optional(),
    alg: z.string().max(32).optional(),
    use: z.string().max(16).optional(),
    /** A private key member; configuring one is refused so a signing key is never deployed here. */
    d: z.undefined().optional(),
  })
  .refine((key) => (key.kty === "OKP" ? key.crv === "Ed25519" && key.y === undefined : key.crv === "P-256" && key.y !== undefined), {
    message: "unsupported key type and curve",
  });
type Jwk = z.infer<typeof Jwk>;

/** One trusted token issuer, as configured in `HM_TRUSTED_ISSUERS`. */
export const TrustedIssuer = z.object({
  iss: z.string().min(1).max(512),
  /** The issuer's public signing keys: Ed25519 (`OKP`) or P-256 (`EC`). Private members are refused. */
  jwks: z.object({ keys: z.array(Jwk).min(1).max(32) }),
  /** Audiences accepted from this issuer; defaults to `HM_AUDIENCE`. */
  audiences: z.array(z.string().min(1).max(512)).min(1).optional(),
});
/** One trusted token issuer. */
export type TrustedIssuer = z.infer<typeof TrustedIssuer>;

/** The trusted issuer list. Issuer names must be unique. */
export const TrustedIssuers = z
  .array(TrustedIssuer)
  .min(1)
  .refine((issuers) => new Set(issuers.map((issuer) => issuer.iss)).size === issuers.length, { message: "duplicate issuer" });

/** The verified identity of a calling service. */
export interface ServiceIdentity {
  readonly issuer: string;
  /** The tenant every request on this token must belong to. */
  readonly tenant: string;
  readonly scopes: ReadonlySet<string>;
  readonly tokenId: string;
}

/** Why a token was refused. The reason is a fixed code, safe to log; it never quotes the token. */
export type AuthFailure =
  | "missing_token"
  | "malformed_token"
  | "unsupported_algorithm"
  | "untrusted_issuer"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "missing_claim";

/** A refused token. Always maps to HTTP 401. */
export class AuthError extends Error {
  override readonly name = "AuthError";
  /** Creates an error for a fixed failure reason. */
  constructor(readonly reason: AuthFailure) {
    super(`service token rejected: ${reason}`);
  }
}

/** Verification settings. */
export interface VerifyOptions {
  readonly issuers: readonly TrustedIssuer[];
  /** The deployment's default audience (`HM_AUDIENCE`). */
  readonly audience: string | undefined;
  /** Current time in seconds since the epoch. */
  readonly now: number;
}

const Header = z.object({ alg: z.string(), kid: z.string().max(256).optional(), typ: z.string().max(64).optional(), crit: z.unknown().optional() });

const Claims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  iat: z.number().optional(),
  jti: z.string().min(1).max(256),
  tenant: OpaqueId,
  scope: z.union([z.string().max(2048), z.array(z.string().max(128)).max(64)]),
});

/** Reads the bearer token from an `Authorization` header, or throws `missing_token`. */
export function bearerToken(header: string | null): string {
  const match = header === null ? null : /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header.trim());
  if (match === null) throw new AuthError("missing_token");
  return match[1]!;
}

/**
 * Verifies a compact JWS service token: EdDSA (Ed25519) or ES256 only, signed by a key of a
 * configured issuer, with `iss`, `aud`, `exp`, optional `nbf`/`iat` (60 s skew), a `jti`, a
 * `tenant` and a `scope`. Every failure throws {@link AuthError}; nothing is trusted before the
 * signature checks out.
 */
export async function verifyServiceToken(token: string, options: VerifyOptions): Promise<ServiceIdentity> {
  if (token.length > MAX_TOKEN_LENGTH) throw new AuthError("malformed_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed_token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = Header.safeParse(decodeJson(encodedHeader));
  if (!header.success) throw new AuthError("malformed_token");
  // Unknown critical extensions must be refused (RFC 7515 §4.1.11); we support none.
  if (header.data.crit !== undefined) throw new AuthError("unsupported_algorithm");
  const algorithm = header.data.alg;
  if (algorithm !== "EdDSA" && algorithm !== "ES256") throw new AuthError("unsupported_algorithm");

  const unverified = decodeJson(encodedPayload);
  const issuerName = typeof unverified === "object" && unverified !== null ? (unverified as { iss?: unknown }).iss : undefined;
  const issuer = options.issuers.find((candidate) => candidate.iss === issuerName);
  if (issuer === undefined) throw new AuthError("untrusted_issuer");

  const jwk = selectKey(issuer, algorithm, header.data.kid);
  const signature = decodeBase64Url(encodedSignature);
  if (signature === null) throw new AuthError("malformed_token");
  const key = await importKey(jwk);
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const params = algorithm === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  if (!(await crypto.subtle.verify(params, key, signature, signed))) throw new AuthError("bad_signature");

  const claims = Claims.safeParse(unverified);
  if (!claims.success) throw new AuthError("missing_claim");
  const { exp, nbf, iat, aud, jti, tenant, scope } = claims.data;
  if (options.now >= exp + CLOCK_SKEW_SECONDS) throw new AuthError("expired");
  if ((nbf !== undefined && options.now < nbf - CLOCK_SKEW_SECONDS) || (iat !== undefined && iat > options.now + CLOCK_SKEW_SECONDS)) {
    throw new AuthError("not_yet_valid");
  }
  const accepted = issuer.audiences ?? (options.audience === undefined ? [] : [options.audience]);
  const audiences = typeof aud === "string" ? [aud] : aud;
  if (!audiences.some((candidate) => accepted.includes(candidate))) throw new AuthError("wrong_audience");

  const scopes = new Set((typeof scope === "string" ? scope.split(" ") : scope).filter((entry) => entry.length > 0));
  return { issuer: issuer.iss, tenant, scopes, tokenId: jti };
}

function selectKey(issuer: TrustedIssuer, algorithm: "EdDSA" | "ES256", kid: string | undefined): Jwk {
  const candidates = issuer.jwks.keys.filter(
    (key) =>
      (algorithm === "EdDSA" ? key.kty === "OKP" : key.kty === "EC") &&
      (key.alg === undefined || key.alg === algorithm) &&
      (key.use === undefined || key.use === "sig") &&
      (kid === undefined || key.kid === kid),
  );
  // Without a kid, only an unambiguous key may be used.
  if (candidates.length !== 1) throw new AuthError("unknown_key");
  return candidates[0]!;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(jwk: Jwk): Promise<CryptoKey> {
  const material: JsonWebKey = jwk.kty === "OKP" ? { kty: "OKP", crv: "Ed25519", x: jwk.x } : { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y! };
  const cacheKey = JSON.stringify(material);
  let key = keyCache.get(cacheKey);
  if (key === undefined) {
    const algorithm = jwk.kty === "OKP" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
    key = crypto.subtle.importKey("jwk", material, algorithm, false, ["verify"]);
    key.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, key);
  }
  return key.catch(() => {
    throw new AuthError("unknown_key");
  });
}

function decodeJson(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
