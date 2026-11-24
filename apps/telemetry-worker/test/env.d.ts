import type { TelemetryEnv } from "../src/index.ts";

declare global {
  namespace Cloudflare {
    /** The test Worker's bindings: the receiver's production Env. */
    interface Env extends TelemetryEnv {}
  }
}
