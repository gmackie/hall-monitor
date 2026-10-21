import { generateKeyPairSync, type JsonWebKey, randomBytes } from "node:crypto";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Fresh signing keys for every run, so no private key is ever committed. The Worker under test
 * trusts the public halves through HM_TRUSTED_ISSUERS; tests sign with the private halves, which
 * reach them through the TEST_SIGNING_KEYS binding.
 */
function keyPair(type: "ed25519" | "p256", kid: string): { publicJwk: JsonWebKey; privateJwk: JsonWebKey } {
  const pair = type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid },
    privateJwk: { ...pair.privateKey.export({ format: "jwk" }), kid },
  };
}

const schoolos = keyPair("ed25519", "schoolos-1");
const playtrek = keyPair("p256", "playtrek-1");
const rogue = keyPair("ed25519", "schoolos-1");

const issuers = [
  { iss: "https://schoolos.test/issuer", jwks: { keys: [schoolos.publicJwk] } },
  { iss: "https://playtrek.test/issuer", jwks: { keys: [playtrek.publicJwk] }, audiences: ["hall-monitor", "hall-monitor-playtrek"] },
];

const overlays = {
  // A district that tightens the educator floor; one weakening field is clamped.
  tenant_overlay: { educator: { revision: "district-7:3", outputModeration: "required", inputModeration: "off" } },
};

const tenantModes = {
  // Shadow mode for educator and content traffic; student profiles stay enforced.
  tenant_shadow: "shadow",
  // A synthetic-traffic tenant explicitly allowed to shadow student profiles.
  tenant_shadow_students: { mode: "shadow", allowStudentShadow: true },
  tenant_enforced: "enforce",
};

export default defineWorkersProject({
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        main: "./test/entry.ts",
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            HM_TRUSTED_ISSUERS: JSON.stringify(issuers),
            HM_POLICY_OVERLAYS: JSON.stringify(overlays),
            HM_TENANT_MODES: JSON.stringify(tenantModes),
            HM_DIGEST_KEY: randomBytes(32).toString("hex"),
            TEST_SIGNING_KEYS: JSON.stringify({
              schoolos: { iss: issuers[0]!.iss, alg: "EdDSA", jwk: schoolos.privateJwk },
              playtrek: { iss: issuers[1]!.iss, alg: "ES256", jwk: playtrek.privateJwk },
              rogue: { iss: issuers[0]!.iss, alg: "EdDSA", jwk: rogue.privateJwk },
            }),
          },
        },
      },
    },
  },
});
