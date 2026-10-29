import type { Env } from "../src/env.ts";
import type { TelemetryEnv } from "../../telemetry-worker/src/index.ts";

declare module "cloudflare:test" {
  /** The test Worker's bindings: the production Env plus the run's private signing keys. */
  interface ProvidedEnv extends Env, TelemetryEnv {
    readonly TEST_SIGNING_KEYS: string;
  }
}
