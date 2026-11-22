import { CURRENT_PRICE_BOOK, MODEL_REGISTRY } from "@gmacko/hall-monitor-costing";
import { evaluateModelGate, type ModelGateEvidence, ModelGatePolicy } from "@gmacko/hall-monitor-shadow-report";
import gatePolicy from "../../../../config/model-gates.json" with { type: "json" };
import { invalid, json, readJson } from "../http.ts";
import { route } from "../router.ts";

/**
 * The model registry with each model's list rates from the current price book. Waiver status is
 * not here: the Worker's `HM_MODEL_ENFORCE_WAIVERS` is a secret the admin cannot read, so the UI
 * shows only what a revision records (`waiverNoted`).
 */
export const modelRoutes = [
  route("GET", "/models", async () =>
    json({
      priceBook: { id: CURRENT_PRICE_BOOK.id, reviewedAt: CURRENT_PRICE_BOOK.reviewedAt },
      models: MODEL_REGISTRY.map((model) => ({
        ...model,
        rates: CURRENT_PRICE_BOOK.rates
          .filter((rate) => rate.providerId === model.providerId && rate.sku === model.modelId)
          .map(({ rateId, unit, numeratorUsdNano, denominator, effectiveFrom, effectiveTo }) => ({ rateId, unit, numeratorUsdNano, denominator, effectiveFrom, ...(effectiveTo === undefined ? {} : { effectiveTo }) })),
      })),
    })),
  /**
   * Runs the model gate (HM-32) over evidence the person uploads (calibration reports, a diff,
   * shadow reports, enrolled models) against config/model-gates.json. Nothing is stored and
   * nothing activates: the verdict is always `activation: "not-approved"`.
   */
  route("POST", "/models:gate", async ({ request }) => {
    const body = await readJson(request) as Partial<Omit<ModelGateEvidence, "policy">> | null;
    if (body === null || typeof body !== "object" || (body.family !== "clef" && body.family !== "clairic")) throw invalid("body is {family, calibration?, diff?, baselineReport?, candidateReport?, enrolledModels?}");
    try {
      return json(evaluateModelGate({ ...body, family: body.family, policy: ModelGatePolicy.parse(gatePolicy) } as ModelGateEvidence));
    } catch {
      throw invalid("the evidence could not be read");
    }
  }),
];
