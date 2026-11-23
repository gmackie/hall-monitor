import { describe, expect, it } from "vitest";
import {
  CLAIRIC_FLASH_MODEL, CLAIRIC_MODEL, CLEF_FLASH_MODEL, CLOUDFLARE_WORKERS_AI, CURRENT_PRICE_BOOK, MODEL_REGISTRY,
  PRICE_BOOK_CLOUDFLARE_2026_10_20, PRICE_BOOK_CLOUDFLARE_2026_11_22, priceAttempt,
} from "../src/index.ts";

const million = (model: string, at: string) =>
  priceAttempt(PRICE_BOOK_CLOUDFLARE_2026_11_22, {
    attemptId: "att", attemptIndex: 0, providerId: CLOUDFLARE_WORKERS_AI, modelId: model, sku: model,
    priceBookId: PRICE_BOOK_CLOUDFLARE_2026_11_22.id, units: { inputTokens: 1_000_000 }, state: "provider_reported",
  }, { at: new Date(at) }).attempt.grossUsdNano;

describe("price book cloudflare-2026-11-22", () => {
  it("carries every 2026-10-20 rate forward unchanged", () => {
    for (const rate of PRICE_BOOK_CLOUDFLARE_2026_10_20.rates) expect(PRICE_BOOK_CLOUDFLARE_2026_11_22.rates).toContainEqual(rate);
    expect(million(CLEF_FLASH_MODEL, "2026-11-22T00:00:00Z")).toBe("38000000");
  });

  it("prices Clairic at the launch rate until 2026-12-01 and the list rate after", () => {
    expect(million(CLAIRIC_MODEL, "2026-11-30T23:59:59Z")).toBe("100000000");
    expect(million(CLAIRIC_MODEL, "2026-12-01T00:00:00Z")).toBe("240000000");
    expect(million(CLAIRIC_FLASH_MODEL, "2026-12-15T00:00:00Z")).toBe("100000000");
  });

  it("is the current book and registers both families", () => {
    expect(CURRENT_PRICE_BOOK.id).toBe("cloudflare-2026-11-22");
    expect(MODEL_REGISTRY.map((model) => [model.family, model.role, model.status])).toEqual([
      ["clef", "primary", "ga"], ["clef", "escalation", "ga"], ["clairic", "primary", "preview"], ["clairic", "escalation", "preview"],
    ]);
  });
});
