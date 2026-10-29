import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { runSyntheticEvaluatorAcceptance } from "../../../packages/evaluator-acceptance/src/index.ts";
import { handle } from "../src/app.ts";
import { fakeAi } from "./fake-ai.ts";
import { mintToken } from "./tokens.ts";

it("runs the complete acceptance workflow against the actual Worker, auth, replay guard and receipt store", async () => {
  fakeAi.reset();
  const revision = "c".repeat(40);
  const credentials = { mode: "synthetic", tenant: "tenant_educateos", source: "educateos", tokens: {
    ready: await mintToken("educateos"), evaluate: await mintToken("educateos"), replay: await mintToken("educateos"), receipt: await mintToken("educateos"),
  } };
  const result = await runSyntheticEvaluatorAcceptance({ target: { url: "https://hall-monitor.test", expectedCommit: revision,
    deploymentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, credentials,
    // This in-process transport never follows redirects. Workerd Request accepts only
    // follow/manual; the production Node transport keeps redirect:error (covered separately).
    fetch: async (url, init) => handle(new Request(String(url), { ...init, redirect: "manual" }), { ...env, AI: fakeAi, FG_COMMIT_HASH: revision }),
  });
  expect(result.checks.every((c) => c.passed), JSON.stringify(result.checks)).toBe(true);
  expect(result).toMatchObject({ passed: true, mode: "synthetic", productionEnrollmentApproved: false });
  expect(result.checks.map((c) => [c.phase, c.status, c.passed])).toEqual([
    ["health", 200, true], ["readiness", 200, true], ["evaluation", 200, true], ["replay", 200, true], ["receipt", 200, true],
  ]);
  expect(fakeAi.calls).toHaveLength(1); // The replay makes no second model call.
  expect(JSON.stringify(result)).not.toContain("tenant_educateos");
  fakeAi.reset();
});
