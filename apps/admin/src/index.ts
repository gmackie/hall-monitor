import { createAdminApp } from "./app.ts";
import type { Env } from "./env.ts";

export type { Env } from "./env.ts";

const app = createAdminApp();

/** The Hall Monitor admin console: the SPA and `/admin/v1/*`, behind Cloudflare Access. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return app(request, env);
  },
} satisfies ExportedHandler<Env>;
