import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as WorkerEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      readonly TEST_ACCESS_JWKS: string;
      readonly TEST_ACCESS_KEY: string;
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}
