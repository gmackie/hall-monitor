// HM-5 acceptance: two products, two tenants, two issuers, one Worker, one SDK, no product code.
import { SELF } from "cloudflare:test";
import { createHallMonitorClient, type HallMonitorClient, serviceBindingTransport } from "@gmacko/hall-monitor-client";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAi } from "./fake-ai.ts";
import { mintToken, type Signer } from "./tokens.ts";

/** A product's integration, as each product would write it: its own issuer, tenant and SDK client. */
function fakeProduct(signer: Signer, tenant: string): HallMonitorClient {
  return createHallMonitorClient({
    transport: serviceBindingTransport(SELF, { getToken: () => mintToken(signer, { tenant }) }),
    timeoutMs: 5_000,
  });
}

function schoolosRequest(): EvaluationRequest {
  return {
    schemaVersion: "1.0",
    requestId: "req_schoolos_tutor_1",
    idempotencyKey: "idem_schoolos_tutor_1",
    source: { product: "schoolos", tenantId: "tenant_district_17", surface: "student.tutor" },
    policy: { profileId: "student-6-8", revision: "builtin-1" },
    context: { audience: "student", gradeBand: "6-8", subject: "math", graded: true, costCenterId: "cc_math_tutor" },
    evaluationKind: "interaction.input",
    content: { type: "text", text: "Can you explain how to find the area of a triangle?" },
    conversation: { priorMessageCount: 2 },
  };
}

function playtrekRequest(): EvaluationRequest {
  return {
    schemaVersion: "1.0",
    requestId: "req_playtrek_quest_1",
    idempotencyKey: "idem_playtrek_quest_1",
    source: { product: "playtrek", tenantId: "tenant_playtrek_studio", surface: "quest.publish" },
    policy: { profileId: "published-content", revision: "builtin-1" },
    context: { audience: "public", costCenterId: "cc_quests" },
    evaluationKind: "content.candidate",
    content: { type: "text", text: "Follow the river trail to the old mill and count the waterwheel paddles." },
  };
}

describe("cross-product acceptance", () => {
  beforeEach(() => fakeAi.reset());

  it("serves SchoolOS and PlayTrek from the same Worker and keeps their receipts apart", async () => {
    const schoolos = fakeProduct("schoolos", "tenant_district_17");
    const playtrek = fakeProduct("playtrek", "tenant_playtrek_studio");

    const tutor = await schoolos.evaluate(schoolosRequest());
    const [quest] = (await playtrek.evaluateBatch([playtrekRequest()])).items;
    expect(tutor.decision).toBe("allow");
    expect(quest?.status).toBe("ok");
    const questResult = quest?.status === "ok" ? quest.result : undefined;
    expect(questResult?.decision).toBe("allow");

    const tutorReceipt = await schoolos.receipt(tutor.evaluationId);
    const questReceipt = await playtrek.receipt(questResult!.evaluationId);
    expect(tutorReceipt).toMatchObject({ tenantId: "tenant_district_17", receipt: { product: "schoolos", purpose: "moderation.input" } });
    expect(questReceipt).toMatchObject({ tenantId: "tenant_playtrek_studio", receipt: { product: "playtrek", purpose: "content.review" } });

    // Neither product can read the other's receipts, even knowing the evaluation id.
    expect(await schoolos.receipt(questResult!.evaluationId)).toBeNull();
    expect(await playtrek.receipt(tutor.evaluationId)).toBeNull();

    // Nor act for the other's tenant.
    await expect(playtrek.evaluate({ ...schoolosRequest(), idempotencyKey: "idem_cross_1" })).rejects.toMatchObject({ code: "forbidden", status: 403 });

    // A retried call replays rather than re-billing.
    const calls = fakeAi.calls.length;
    expect(await schoolos.evaluate(schoolosRequest())).toEqual(tutor);
    expect(fakeAi.calls).toHaveLength(calls);

    const capabilities = await playtrek.capabilities();
    expect(capabilities.classifier.enabled).toBe(true);
  });
});
