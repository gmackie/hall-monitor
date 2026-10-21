import { env } from "cloudflare:test";

/** A signer configured for this test run (see vitest.config.ts). `rogue` reuses a trusted kid with an untrusted key. */
export type Signer = "schoolos" | "playtrek" | "rogue";

interface SigningKey {
  readonly iss: string;
  readonly alg: "EdDSA" | "ES256";
  readonly jwk: JsonWebKey & { kid: string };
}

const keys = JSON.parse(env.TEST_SIGNING_KEYS) as Record<Signer, SigningKey>;

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

/** Options for {@link mintToken}. Claims set to `undefined` are omitted. */
export interface MintOptions {
  readonly tenant?: string;
  readonly scope?: string | string[];
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
}

/**
 * Mints a service token signed with a test key: Ed25519 (EdDSA) for `schoolos` and `rogue`,
 * P-256 (ES256) for `playtrek`. Defaults: audience `hall-monitor`, five-minute lifetime, both scopes.
 */
export async function mintToken(signer: Signer, options: MintOptions = {}): Promise<string> {
  const key = keys[signer];
  const now = Math.floor(Date.now() / 1000);
  const header = Object.fromEntries(Object.entries({ alg: key.alg, typ: "JWT", kid: key.jwk.kid, ...options.header }).filter(([, v]) => v !== undefined));
  const claims = Object.fromEntries(
    Object.entries({
      iss: key.iss,
      aud: "hall-monitor",
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
      tenant: options.tenant ?? "tenant_schoolos",
      scope: options.scope ?? "evaluate receipts:read",
      ...options.claims,
    }).filter(([, v]) => v !== undefined),
  );
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const { kid: _kid, ...material } = key.jwk;
  const algorithm = key.alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey("jwk", material, algorithm, false, ["sign"]);
  const params = key.alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  const signature = new Uint8Array(await crypto.subtle.sign(params, privateKey, encoder.encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}
