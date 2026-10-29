import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { handle } from "../src/app.ts";
import type { Env } from "../src/env.ts";

const REVISION = "a".repeat(40);
it("identifies the deployed revision on success and denial without trusting request headers", async () => {
  for (const path of ["/v1/health", "/v1/ready", "/missing"]) {
    const request = new Request(`https://hall-monitor.test${path}`, { headers: { "x-hm-revision": "b".repeat(40) } });
    const response = await handle(request, { ...env, FG_COMMIT_HASH: REVISION });
    expect(response.headers.get("x-hm-revision")).toBe(REVISION);
    expect(response.headers.get("x-hm-telemetry-posture")).toBe("unbound-disabled");
  }
  const unconfigured = await handle(new Request("https://hall-monitor.test/v1/health", { headers: { "x-hm-revision": REVISION } }), env);
  expect(unconfigured.headers.has("x-hm-revision")).toBe(false);
});

it.each([undefined, "bad-build-value", "SYNTHETIC-PRIVATE-CONFIG", "a".repeat(41)])("omits unsuitable release metadata (%s)", async (revision) => {
  const b = { ...env } as Env;
  if (revision !== undefined) Object.assign(b, { FG_COMMIT_HASH: revision });
  const response = await handle(new Request("https://hall-monitor.test/v1/health"), b);
  expect(response.headers.has("x-hm-revision")).toBe(false);
  expect(await response.text()).toBe('{"status":"ok"}');
});

it.each([
  { HM_TELEMETRY_ENABLED: "true" }, { HM_TELEMETRY_V2_ENABLED: "true" },
  { METRICS_COLLECTOR: { fetch: async () => new Response(null) } },
])("never labels a deployment unbound/default-off with a collection switch or binding (%o)", async (extra) => {
  const response = await handle(new Request("https://hall-monitor.test/v1/health"), { ...env, ...extra });
  expect(response.headers.get("x-hm-telemetry-posture")).toBe("configured");
});
