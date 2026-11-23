import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/env.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    readonly TEST_ACCESS_JWKS: string;
    readonly TEST_ACCESS_KEY: string;
    readonly TEST_MIGRATIONS: D1Migration[];
  }
}
