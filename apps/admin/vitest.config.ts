import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { defineWorkersProject, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * A fresh Access signing key for every run, so no private key is committed. The admin Worker
 * trusts the public half through the injected JWKS source; tests sign with the private half.
 */
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-access-1", alg: "RS256", use: "sig" };
const privateJwk = { ...pair.privateKey.export({ format: "jwk" }), kid: "test-access-1" };

export default defineWorkersProject(async () => ({
  test: {
    name: "admin",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./test/entry.ts",
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            HM_ADMIN_ACCESS_TEAM_DOMAIN: "hm-test.cloudflareaccess.com",
            HM_ADMIN_ACCESS_AUD: "test-aud",
            HM_ADMIN_BOOTSTRAP_EMAILS: "root@example.test",
            TEST_ACCESS_JWKS: JSON.stringify({ keys: [publicJwk] }),
            TEST_ACCESS_KEY: JSON.stringify(privateJwk),
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          },
        },
      },
    },
  },
}));
