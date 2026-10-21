import { describe, expect, it } from "vitest";
import {
  ceilToCents,
  formatUsdCents,
  formatUsdNano,
  mulRationalCeil,
  parseUsdNano,
  sumUsdNano,
  usdToNano,
} from "../src/index.ts";

describe("UsdNano helpers", () => {
  it("round-trips the wire form without floats", () => {
    expect(parseUsdNano("22876")).toBe(22876n);
    expect(parseUsdNano("-15")).toBe(-15n);
    expect(formatUsdNano(9_007_199_254_740_993n)).toBe("9007199254740993");
    for (const bad of ["1.5", "1e3", "", " 1", "0x10", "007", "-0"]) expect(() => parseUsdNano(bad)).toThrow(TypeError);
    expect(formatUsdNano(0n)).toBe("0");
    expect(formatUsdNano(-15n)).toBe("-15");
    expect(() => formatUsdNano(10n ** 30n)).toThrow(RangeError);
  });

  it("converts exact decimal dollars and refuses sub-nanodollar precision", () => {
    expect(usdToNano("0.038")).toBe(38_000_000n);
    expect(usdToNano("5")).toBe(5_000_000_000n);
    expect(usdToNano("-0.000000001")).toBe(-1n);
    expect(() => usdToNano("0.0000000001")).toThrow(TypeError);
  });

  it("sums exactly beyond the float-safe range", () => {
    expect(sumUsdNano([2n ** 60n, 1n, 1n])).toBe(2n ** 60n + 2n);
    expect(sumUsdNano([])).toBe(0n);
  });

  it("multiplies by a rational, rounding only fractions up", () => {
    expect(mulRationalCeil(602n, { numerator: 38_000_000n, denominator: 1_000_000n })).toBe(22_876n);
    expect(mulRationalCeil(1n, { numerator: 38n, denominator: 1_000n })).toBe(1n);
    expect(mulRationalCeil(0n, { numerator: 38n, denominator: 1_000n })).toBe(0n);
    expect(() => mulRationalCeil(1n, { numerator: 1n, denominator: 0n })).toThrow(RangeError);
  });

  it("rounds to cents only for presentation, upward", () => {
    expect(ceilToCents(215_040_000n)).toBe(22n);
    expect(ceilToCents(10_000_000n)).toBe(1n);
    expect(ceilToCents(10_000_001n)).toBe(2n);
    expect(formatUsdCents(7_200_000_000n)).toBe("$7.20");
    expect(formatUsdCents(22_876n)).toBe("$0.01");
    expect(formatUsdCents(0n)).toBe("$0.00");
  });
});
