import { defineProject } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// The receiver is stateful (a SQLite Durable Object per tenant), so its tests run in the Workers
// pool against the real object. The test config adds only the runner's nodejs_compat flag to the
// production bindings; no secrets or enrolment are baked in, tests supply their own per call.
export default defineProject({
  plugins: [cloudflareTest({
    main: "./test/entry.ts",
    wrangler: { configPath: "./test/wrangler.test.jsonc" },
  })],
  test: {
    name: "telemetry-worker",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../reset-test-storage.ts"],
    fileParallelism: false,
  },
});
