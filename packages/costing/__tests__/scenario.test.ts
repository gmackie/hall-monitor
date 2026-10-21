import { describe, expect, it } from "vitest";
import { hallMonitorScenario, hallMonitorSafetyReserveUsdNano, usdToNano } from "../src/index.ts";

describe("hallMonitorScenario (03-PRICING §4)", () => {
  it.each([
    ["Educator-only co-op", 6, 0, 1_920n, "0.14592", "0.06912", "0.21504"],
    ["Homeschool co-op", 12, 60, 8_520n, "0.64752", "0.30672", "0.95424"],
    ["Hybrid academy", 35, 200, 26_800n, "2.03680", "0.96480", "3.00160"],
    ["District", 180, 1050, 139_500n, "10.60200", "5.02200", "15.62400"],
    ["Managed: ten co-ops", 120, 600, 85_200n, "6.47520", "3.06720", "9.54240"],
  ])("%s (%i teachers, %i students)", (_name, activeTeachers, aiStudents, messages, flash, escalation, total) => {
    expect(hallMonitorScenario({ activeTeachers, aiStudents })).toEqual({
      messages,
      flashUsdNano: usdToNano(flash),
      escalationUsdNano: usdToNano(escalation),
      totalUsdNano: usdToNano(total),
    });
  });

  it("states the homeschool total in nanodollars", () => {
    expect(hallMonitorScenario({ activeTeachers: 6, aiStudents: 0 }).totalUsdNano).toBe(215_040_000n);
  });
});

describe("hallMonitorScenario sensitivity (03-PRICING §5, homeschool co-op)", () => {
  const homeschool = { activeTeachers: 12, aiStudents: 60 };
  it.each([
    ["base", {}, "0.95424"],
    ["input checks only", { outputCheckTokens: 0 }, "0.63048"],
    ["500 tokens per check", { inputCheckTokens: 500, outputCheckTokens: 500 }, "0.63048"],
    ["2,000 tokens per check", { inputCheckTokens: 2000, outputCheckTokens: 2000 }, "1.60176"],
    ["5% escalation", { escalationShare: { num: 1, den: 20 } }, "0.80088"],
    ["20% escalation", { escalationShare: { num: 1, den: 5 } }, "1.26096"],
  ])("%s", (_name, overrides, total) => {
    expect(hallMonitorScenario({ ...homeschool, ...overrides }).totalUsdNano).toBe(usdToNano(total));
  });

  it("rejects non-integer counts and impossible shares", () => {
    expect(() => hallMonitorScenario({ activeTeachers: 1.5, aiStudents: 0 })).toThrow(RangeError);
    expect(() => hallMonitorScenario({ ...homeschool, escalationShare: { num: 2, den: 1 } })).toThrow(RangeError);
  });
});

describe("hallMonitorSafetyReserveUsdNano (03-PRICING §7)", () => {
  it("is $0.10 per AI-enabled person above the floor: 120-enrollment co-op = $7.20", () => {
    expect(hallMonitorSafetyReserveUsdNano({ activeTeachers: 12, aiStudents: 60 })).toBe(usdToNano("7.20"));
  });

  it("never falls below $5", () => {
    expect(hallMonitorSafetyReserveUsdNano({ activeTeachers: 6, aiStudents: 0 })).toBe(usdToNano("5"));
    expect(hallMonitorSafetyReserveUsdNano({ activeTeachers: 0, aiStudents: 0 })).toBe(usdToNano("5"));
  });
});
