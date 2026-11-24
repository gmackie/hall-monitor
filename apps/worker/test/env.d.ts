import type { Env as WorkerEnv } from "../src/env.ts";
import type { TelemetryEnv } from "../../telemetry-worker/src/index.ts";

declare global {
  namespace Cloudflare {
    /** The test Worker's bindings: the production Env plus the run's private signing keys. */
    interface Env extends WorkerEnv, TelemetryEnv {
      readonly TEST_SIGNING_KEYS: string;
    }
  }
}
