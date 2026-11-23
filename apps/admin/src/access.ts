import type { Env } from "./env.ts";

/** Seconds of clock skew allowed on `exp` and `nbf`. */
export const ACCESS_CLOCK_SKEW_SECONDS = 60;
/** How long fetched Access signing keys are reused within an isolate. */
const JWKS_TTL_MS = 5 * 60 * 1000;

/** Why an Access token was refused: fixed codes, for logs. */
export type AccessFailure = "missing" | "malformed" | "algorithm" | "unknown_key" | "signature" | "issuer" | "audience" | "expired" | "not_yet_valid" | "no_email";

export class AccessError extends Error {
  constructor(readonly reason: AccessFailure) {
    super(reason);
  }
}

/** Raised when Access is not configured: every API call fails closed with 503. */
export class AccessUnconfigured extends Error {}

/** An RSA public key from the Access certs endpoint. */
export interface AccessJwk extends JsonWebKey {
  readonly kid?: string;
}

/** Where verification gets the team's signing keys. Production fetches the Access certs endpoint. */
export type JwksSource = (env: Env, teamDomain: string) => Promise<readonly AccessJwk[]>;

let jwksCache: { readonly teamDomain: string; readonly keys: readonly AccessJwk[]; readonly at: number } | undefined;

/** Fetches `https://<team>/cdn-cgi/access/certs`, cached for five minutes per isolate. */
export const fetchAccessJwks: JwksSource = async (_env, teamDomain) => {
  if (jwksCache !== undefined && jwksCache.teamDomain === teamDomain && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("access certs unavailable");
  const body = (await response.json()) as { keys?: AccessJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { teamDomain, keys, at: Date.now() };
  return keys;
};

/** The signed-in person, as Access asserts them. */
export interface AccessIdentity {
  readonly email: string;
}

/** The Access settings, or AccessUnconfigured. A domain must be a bare hostname. */
export function accessSettings(env: Env): { teamDomain: string; audience: string } {
  const teamDomain = env.HM_ADMIN_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const audience = env.HM_ADMIN_ACCESS_AUD?.trim() ?? "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(teamDomain) || audience === "") throw new AccessUnconfigured("access is not configured");
  return { teamDomain, audience };
}

/**
 * Verifies a Cloudflare Access application token (`Cf-Access-Jwt-Assertion`): RS256 only, a key
 * from the team's JWKS by `kid`, `iss` equal to `https://<team>`, `aud` containing the
 * application's tag, `exp`/`nbf` within 60 s of skew, and an `email` claim.
 */
export async function verifyAccessToken(token: string | null, options: {
  readonly teamDomain: string;
  readonly audience: string;
  readonly keys: readonly AccessJwk[];
  readonly now: number;
}): Promise<AccessIdentity> {
  if (token === null || token === "") throw new AccessError("missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodeJson(rawHeader) as { alg?: unknown; kid?: unknown };
  const payload = decodeJson(rawPayload) as Record<string, unknown>;
  if (header.alg !== "RS256") throw new AccessError("algorithm");
  const jwk = options.keys.find((key) => typeof header.kid === "string" && key.kid === header.kid);
  if (jwk === undefined || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new AccessError("unknown_key");
  const { n, e } = jwk;
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(rawSignature), new TextEncoder().encode(`${rawHeader}.${rawPayload}`));
  } catch {
    throw new AccessError("signature");
  }
  if (!valid) throw new AccessError("signature");
  if (payload.iss !== `https://${options.teamDomain}`) throw new AccessError("issuer");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(options.audience)) throw new AccessError("audience");
  if (typeof payload.exp !== "number" || payload.exp + ACCESS_CLOCK_SKEW_SECONDS < options.now) throw new AccessError("expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - ACCESS_CLOCK_SKEW_SECONDS > options.now)) throw new AccessError("not_yet_valid");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email)) throw new AccessError("no_email");
  return { email };
}

function decodeJson(part: string): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new AccessError("malformed");
  }
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new AccessError("malformed");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
