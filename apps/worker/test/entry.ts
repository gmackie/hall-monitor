// The Worker under test: the real handler with the fake AI binding injected. Nothing here ships.
import worker, { type Env } from "../src/index.ts";
import { fakeAi } from "./fake-ai.ts";

export { IdempotencyStore } from "../src/index.ts";

export default {
  fetch(request, env) {
    return worker.fetch(request, { ...env, AI: fakeAi });
  },
} satisfies ExportedHandler<Env>;
