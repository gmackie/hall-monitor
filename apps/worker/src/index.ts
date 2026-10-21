import { handle } from "./app.ts";
import type { Env } from "./env.ts";

export { TokenReplayGuard } from "./replay.ts";
export { IdempotencyStore } from "./store.ts";
export type { Env } from "./env.ts";

/** The Hall Monitor Worker. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
