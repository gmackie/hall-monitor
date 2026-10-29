import type { TelemetryEnv } from "../src/index.ts";

declare module "cloudflare:test" {
  /** The test Worker's bindings: the receiver's production Env. */
  interface ProvidedEnv extends TelemetryEnv {}
}
