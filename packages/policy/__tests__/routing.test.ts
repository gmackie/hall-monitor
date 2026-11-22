import { describe, expect, it } from "vitest";
import { applyOverlay, DEFAULT_ROUTING, familyRouting, routeFor, STUDENT_9_12_PROFILE } from "../src/index.ts";

describe("family routing", () => {
  it("defaults to Clef enforcing everywhere and Clairic off", () => {
    expect(familyRouting(STUDENT_9_12_PROFILE, "clef")).toEqual(DEFAULT_ROUTING.clef);
    expect(routeFor(STUDENT_9_12_PROFILE, "clairic", "interaction.input")).toBeNull();
  });

  it("lets an overlay switch Clairic on, to enforce and to more kinds", () => {
    const shadow = applyOverlay(STUDENT_9_12_PROFILE, { revision: "t-1", routing: { clairic: { enabled: true, mode: "shadow", kinds: ["interaction.output"] } } });
    expect(shadow.violations).toEqual([]);
    expect(routeFor(shadow.profile, "clairic", "interaction.output")).toMatchObject({ mode: "shadow" });
    expect(routeFor(shadow.profile, "clairic", "interaction.input")).toBeNull();
    const wider = applyOverlay(shadow.profile, { revision: "t-2", routing: { clairic: { enabled: true, mode: "enforce", kinds: ["interaction.output", "interaction.input"] } } });
    expect(wider.violations).toEqual([]);
    expect(wider.profile.routing?.clairic).toEqual({ enabled: true, mode: "enforce", kinds: ["interaction.output", "interaction.input"] });
  });

  it("refuses to switch a family off, back to shadow, or to fewer kinds", () => {
    const floor = applyOverlay(STUDENT_9_12_PROFILE, { revision: "t-1", routing: { clairic: { enabled: true, mode: "enforce", kinds: ["interaction.output", "interaction.input"] } } }).profile;
    const weaker = applyOverlay(floor, { revision: "t-2", routing: { clef: { enabled: false, mode: "shadow" }, clairic: { enabled: false, mode: "shadow", kinds: ["interaction.output"] } } });
    expect(weaker.violations.map((violation) => violation.field)).toEqual([
      "routing.clef.enabled", "routing.clef.mode", "routing.clairic.enabled", "routing.clairic.mode", "routing.clairic.kinds",
    ]);
    expect(weaker.profile.routing).toEqual({ clef: { enabled: true, mode: "enforce" }, clairic: floor.routing!.clairic });
  });

  it("refuses to narrow a family that runs on every kind", () => {
    const narrowed = applyOverlay(STUDENT_9_12_PROFILE, { revision: "t-1", routing: { clef: { enabled: true, mode: "enforce", kinds: ["interaction.input"] } } });
    expect(narrowed.violations.map((violation) => violation.field)).toEqual(["routing.clef.kinds"]);
    expect(narrowed.profile.routing?.clef).toEqual({ enabled: true, mode: "enforce" });
  });

  it("leaves profiles without routing unchanged", () => {
    expect(applyOverlay(STUDENT_9_12_PROFILE, { revision: "t-1" }).profile.routing).toBeUndefined();
  });
});
