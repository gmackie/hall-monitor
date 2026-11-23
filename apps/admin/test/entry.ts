// The admin Worker under test: the real handler with Access keys from the run's binding and the
// in-memory evaluator injected. Nothing here ships.
import { createAdminApp } from "../src/app.ts";
import type { Env } from "../src/env.ts";
import { fakeEvaluator } from "./fake-evaluator.ts";

const app = createAdminApp({
  jwks: async (env) => (JSON.parse((env as Env & { TEST_ACCESS_JWKS: string }).TEST_ACCESS_JWKS) as { keys: JsonWebKey[] }).keys,
  evaluator: () => fakeEvaluator,
});

export default {
  fetch(request: Request, env: Env) {
    return app(request, env);
  },
} satisfies ExportedHandler<Env>;
