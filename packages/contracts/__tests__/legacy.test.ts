import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as current from "../src/index.ts";
import * as v020 from "./legacy/v0.2.0/index.ts";

/**
 * PlayTrek pins 0.2.0. Its client validates every response with the 0.2.0 schemas, so documents
 * this release emits must still parse there: new fields are optional and stripped, and no response
 * enum gained a value.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1.0/${name}`, import.meta.url), "utf8"));
}

describe("0.2.0 clients reading 0.5.0 responses", () => {
  it("parses a result with route and evidence, ignoring the new fields", () => {
    const document = fixture("result-route.json") as Record<string, unknown>;
    expect(current.EvaluationResult.parse(document)).toEqual(document);
    const legacy = v020.EvaluationResult.parse(document);
    expect(legacy.decision).toBe("coach");
    expect("route" in legacy).toBe(false);
    expect(legacy.receipt?.attempts.map((attempt) => attempt.modelId)).toEqual(["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"]);
  });

  it("parses capabilities with models and a reason-code revision", () => {
    const document = {
      ...(fixture("capabilities.json") as object),
      models: [{ family: "clef", modelId: "@cf/cloudflare/clef-flash", role: "primary", status: "ga" }],
      reasonCodesRevision: current.REASON_CODES_REVISION,
    };
    expect(current.Capabilities.parse(document)).toEqual(document);
    expect(v020.Capabilities.safeParse(document).success).toBe(true);
  });

  it("keeps every response enum a 0.2.0 client knows unchanged", () => {
    expect(current.Decision.options).toEqual(v020.Decision.options);
    expect(current.FindingCategory.options).toEqual(v020.FindingCategory.options);
    expect(current.Severity.options).toEqual(v020.Severity.options);
    expect(current.DegradedReason.options).toEqual(v020.DegradedReason.options);
    expect(current.ErrorCode.options).toEqual(v020.ErrorCode.options);
  });

  it("documents the one breaking enum change since 0.2.0: Product", () => {
    expect(v020.Product.options).toContain("schoolos");
    expect(current.Product.options).not.toContain("schoolos");
    expect(current.Product.options).toContain("educateos");
    expect(current.Product.options).toContain("playtrek");
  });
});

describe("0.5.0 read API documents", () => {
  it.each([
    ["evaluation-record.json", current.EvaluationRecord],
    ["evaluation-page.json", current.EvaluationPage],
  ] as const)("round-trips %s", (name, schema) => {
    const document = fixture(name);
    expect(schema.parse(document)).toEqual(document);
  });

  it("keeps the reason-code catalog valid and unique", () => {
    const catalog = current.ReasonCodeCatalog.parse({ schemaVersion: "1.0", revision: current.REASON_CODES_REVISION, codes: current.REASON_CODES });
    expect(new Set(catalog.codes.map((code) => code.code)).size).toBe(catalog.codes.length);
  });

  it("encodes and parses list queries, naming bad parameters only", () => {
    const query = { limit: 25, decision: "hold", escalated: true, reasonCode: "clef.harassment", from: "2026-11-01T00:00:00Z" } as const;
    const params = current.evaluationQueryParams(query);
    expect(current.parseEvaluationQuery(params)).toEqual({ ok: true, query });
    expect(current.parseEvaluationQuery(new URLSearchParams("limit=0&decision=maybe&secret=x"))).toEqual({ ok: false, fields: ["(unknown)", "decision", "limit"] });
    expect(current.parseEvaluationQuery(new URLSearchParams("limit=1&limit=2"))).toEqual({ ok: false, fields: ["limit"] });
    expect(current.parseEvaluationQuery(new URLSearchParams("escalated=yes"))).toEqual({ ok: false, fields: ["escalated"] });
  });
});
