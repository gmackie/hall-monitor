import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

// The receiver is stateful (a SQLite Durable Object per tenant), so its tests run in the Workers
// pool against the real object. The test config adds only the runner's nodejs_compat flag to the
// production bindings; no secrets or enrolment are baked in, tests supply their own per call.
export default defineWorkersProject({
  test: {
    name: "telemetry-worker",
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Serialize files in this runtime; storage remains isolated between tests.
        singleWorker: true,
        main: "./test/entry.ts",
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
      },
    },
  },
});
