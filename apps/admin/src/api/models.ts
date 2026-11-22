import { CURRENT_PRICE_BOOK, MODEL_REGISTRY } from "@gmacko/hall-monitor-costing";
import { json } from "../http.ts";
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
];
