import type { UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { describe, expect, it } from "vitest";
import {
  buildReceipt,
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  CLOUDFLARE_WORKERS_AI,
  definePriceBook,
  PRICE_BOOK_CLOUDFLARE_2026_10_20 as BOOK,
  priceAttempt,
  WORKERS_AI_NEURONS_SKU,
} from "../src/index.ts";

function attempt(overrides: Partial<UsageAttempt> = {}): UsageAttempt {
  return {
    attemptId: "att_1",
    attemptIndex: 0,
    providerId: CLOUDFLARE_WORKERS_AI,
    modelId: CLEF_FLASH_MODEL,
    sku: CLEF_FLASH_MODEL,
    priceBookId: BOOK.id,
    units: { inputTokens: 602 },
    state: "provider_reported",
    ...overrides,
  };
}

describe("PRICE_BOOK_CLOUDFLARE_2026_10_20", () => {
  it("is deeply immutable", () => {
    expect(Object.isFrozen(BOOK)).toBe(true);
    expect(Object.isFrozen(BOOK.rates)).toBe(true);
    expect(Object.isFrozen(BOOK.rates[0])).toBe(true);
    expect(() => {
      (BOOK.rates as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("rejects duplicate rate ids", () => {
    const [rate] = BOOK.rates;
    expect(() => definePriceBook({ id: "dup", reviewedAt: BOOK.reviewedAt, rates: [rate!, rate!] })).toThrow(TypeError);
  });
});

describe("priceAttempt", () => {
  it("prices 602 Clef-flash tokens at exactly 22,876 nanodollars", () => {
    expect(priceAttempt(BOOK, attempt()).attempt.grossUsdNano).toBe("22876");
  });

  it("prices 1,000 Clef-flash tokens at exactly 38,000 nanodollars and ignores output tokens", () => {
    const priced = priceAttempt(BOOK, attempt({ units: { inputTokens: 1000, outputTokens: 40 } }));
    expect(priced).toEqual({ attempt: expect.objectContaining({ grossUsdNano: "38000", state: "provider_reported" }), issue: null });
  });

  it("prices Clef escalations and neurons", () => {
    expect(priceAttempt(BOOK, attempt({ sku: CLEF_MODEL, modelId: CLEF_MODEL, units: { inputTokens: 1500 } })).attempt.grossUsdNano).toBe(
      "360000",
    );
    const neurons = attempt({ sku: WORKERS_AI_NEURONS_SKU, modelId: "@cf/meta/llama", units: { neurons: 1000 } });
    expect(priceAttempt(BOOK, neurons).attempt.grossUsdNano).toBe("11000000");
  });

  it("rounds a fractional nanodollar up", () => {
    expect(priceAttempt(BOOK, attempt({ units: { inputTokens: 1 } })).attempt.grossUsdNano).toBe("38");
    const tiny = attempt({ sku: WORKERS_AI_NEURONS_SKU, units: { neurons: 1 } });
    expect(priceAttempt(BOOK, tiny).attempt.grossUsdNano).toBe("11000");
  });

  it("marks missing usage unknown instead of zero", () => {
    const priced = priceAttempt(BOOK, attempt({ units: {} }));
    expect(priced.issue).toBe("missing_units");
    expect(priced.attempt.state).toBe("unknown");
    expect(priced.attempt.grossUsdNano).toBeUndefined();
  });

  it("never double-counts cached tokens and flags impossible cache counts", () => {
    // No cached rate for Clef-flash: cached tokens are charged as ordinary input, once.
    expect(priceAttempt(BOOK, attempt({ units: { inputTokens: 1000, cachedInputTokens: 400 } })).attempt.grossUsdNano).toBe("38000");
    const impossible = priceAttempt(BOOK, attempt({ units: { inputTokens: 10, cachedInputTokens: 11 } }));
    expect(impossible.issue).toBe("cached_exceeds_input");
    expect(impossible.attempt.state).toBe("unknown");
  });

  it("charges cached tokens at their own rate when the SKU has one", () => {
    const book = definePriceBook({
      id: "cache-book",
      reviewedAt: "2026-10-20T00:00:00Z",
      rates: [
        { ...BOOK.rates[0]!, rateId: "in", sku: "m", numeratorUsdNano: "1000", denominator: "1" },
        { ...BOOK.rates[0]!, rateId: "cached", sku: "m", unit: "cached_input_tokens", numeratorUsdNano: "100", denominator: "1" },
        { ...BOOK.rates[0]!, rateId: "out", sku: "m", unit: "output_tokens", numeratorUsdNano: "3000", denominator: "1" },
      ],
    });
    const priced = priceAttempt(
      book,
      attempt({ priceBookId: "cache-book", sku: "m", units: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } }),
    );
    // 6 uncached × 1000 + 4 cached × 100 + 2 output × 3000
    expect(priced.attempt.grossUsdNano).toBe("12400");
    const noOutput = priceAttempt(book, attempt({ priceBookId: "cache-book", sku: "m", units: { inputTokens: 10 } }));
    expect(noOutput.issue).toBe("missing_units");
  });

  it("refuses attempts from another book, unknown SKUs and already-unknown usage", () => {
    expect(priceAttempt(BOOK, attempt({ priceBookId: "other" })).issue).toBe("price_book_mismatch");
    expect(priceAttempt(BOOK, attempt({ sku: "@cf/unknown" })).issue).toBe("no_rate");
    expect(priceAttempt(BOOK, attempt({ state: "unknown", grossUsdNano: "5" })).attempt).not.toHaveProperty("grossUsdNano");
  });

  it("selects rates by effective date", () => {
    expect(priceAttempt(BOOK, attempt(), { at: new Date("2026-10-01T00:00:00Z") }).issue).toBe("no_rate");
    expect(priceAttempt(BOOK, attempt(), { at: new Date("2026-10-21T00:00:00Z") }).attempt.grossUsdNano).toBe("22876");
  });
});

describe("buildReceipt", () => {
  const base = {
    receiptId: "rcpt_1",
    tenantId: "tenant_1",
    product: "educateos",
    costCenterId: "cc_1",
    logicalRequestId: "req_1",
    createdAt: "2026-10-20T12:00:00.000Z",
    purpose: "moderation.input",
  } as const;

  it("sums one receipt over several attempts", () => {
    const flash = priceAttempt(BOOK, attempt()).attempt;
    const clef = priceAttempt(
      BOOK,
      attempt({ attemptId: "att_2", attemptIndex: 1, sku: CLEF_MODEL, modelId: CLEF_MODEL, units: { inputTokens: 1500 } }),
    ).attempt;
    const receipt = buildReceipt({ ...base, attempts: [flash, clef] });
    expect(receipt.totalGrossUsdNano).toBe("382876");
    expect(receipt.hasUnknownCost).toBe(false);
  });

  it("flags unknown cost and keeps the known total as a lower bound", () => {
    const known = priceAttempt(BOOK, attempt()).attempt;
    const missing = priceAttempt(BOOK, attempt({ attemptId: "att_2", attemptIndex: 1, units: {} })).attempt;
    const receipt = buildReceipt({ ...base, attempts: [known, missing] });
    expect(receipt).toMatchObject({ totalGrossUsdNano: "22876", hasUnknownCost: true });
  });
});
