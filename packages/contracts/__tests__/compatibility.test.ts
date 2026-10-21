import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "../src/index.ts";

/**
 * Every exported wire schema, by name. The JSON Schema snapshot below fails on any shape change;
 * when the change is intentional, regenerate with `vitest run -u` and check that it is additive
 * (only new optional fields) or bump SCHEMA_VERSION's major and add a migration.
 */
const WIRE_SCHEMAS = {
  SchemaVersion: contracts.SchemaVersion,
  OpaqueId: contracts.OpaqueId,
  UsdNano: contracts.UsdNano,
  SignedUsdNano: contracts.SignedUsdNano,
  MachineCode: contracts.MachineCode,
  Product: contracts.Product,
  EvaluationKind: contracts.EvaluationKind,
  Decision: contracts.Decision,
  GradeBand: contracts.GradeBand,
  Audience: contracts.Audience,
  EvaluationContent: contracts.EvaluationContent,
  EvaluationRequest: contracts.EvaluationRequest,
  FindingCategory: contracts.FindingCategory,
  Severity: contracts.Severity,
  Finding: contracts.Finding,
  UsageAttempt: contracts.UsageAttempt,
  CostReceipt: contracts.CostReceipt,
  EvaluationResult: contracts.EvaluationResult,
  ErrorBody: contracts.ErrorBody,
  Capabilities: contracts.Capabilities,
} satisfies Record<string, z.ZodType>;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1.0/${name}`, import.meta.url), "utf8"));
}

describe("wire schema compatibility", () => {
  it("matches the frozen JSON Schema of every wire type", async () => {
    const jsonSchemas = Object.fromEntries(
      Object.entries(WIRE_SCHEMAS).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
    );
    await expect(JSON.stringify(jsonSchemas, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/wire-schemas.json",
    );
  });

  it.each([
    ["request.json", contracts.EvaluationRequest],
    ["request-digest.json", contracts.EvaluationRequest],
    ["result.json", contracts.EvaluationResult],
    ["result-degraded.json", contracts.EvaluationResult],
    ["error.json", contracts.ErrorBody],
    ["capabilities.json", contracts.Capabilities],
  ] as const)("still parses the frozen v1.0 document %s unchanged", (name, schema) => {
    const document = fixture(name);
    expect(schema.parse(document)).toEqual(document);
  });
});

describe("isCompatibleSchemaVersion", () => {
  it("accepts every supported version", () => {
    for (const version of contracts.SUPPORTED_SCHEMA_VERSIONS) {
      expect(contracts.isCompatibleSchemaVersion(version)).toBe(true);
    }
    expect(contracts.isCompatibleSchemaVersion(contracts.SCHEMA_VERSION)).toBe(true);
  });

  it("refuses other majors, newer minors and malformed versions", () => {
    for (const version of ["2.0", "0.9", "1.1", "1", "1.0.0", "", "v1.0"]) {
      expect(contracts.isCompatibleSchemaVersion(version)).toBe(false);
    }
  });
});

describe("content safety of the schemas", () => {
  it("rejects unknown severities, decisions and categories", () => {
    const finding = (fixture("result.json") as { findings: unknown[] }).findings[0] as object;
    expect(contracts.Finding.safeParse({ ...finding, severity: "critical" }).success).toBe(false);
    expect(contracts.Finding.safeParse({ ...finding, category: "spam" }).success).toBe(false);
    expect(contracts.Decision.safeParse("escalate").success).toBe(false);
  });

  it("keeps free text out of identifiers and reason codes", () => {
    expect(contracts.OpaqueId.safeParse("my essay about the war").success).toBe(false);
    expect(contracts.MachineCode.safeParse("Contains: secret text").success).toBe(false);
  });

  it("refuses inverted spans and non-canonical, fractional or negative money", () => {
    expect(contracts.Span.safeParse({ start: 5, end: 2 }).success).toBe(false);
    for (const valid of ["0", "22876", "9".repeat(30)]) expect(contracts.UsdNano.safeParse(valid).success).toBe(true);
    for (const invalid of ["-1", "1.5", "007", "", "+5", "1e3", "9".repeat(31)]) {
      expect(contracts.UsdNano.safeParse(invalid).success, invalid).toBe(false);
    }
    for (const valid of ["0", "-15", "15"]) expect(contracts.SignedUsdNano.safeParse(valid).success).toBe(true);
    for (const invalid of ["-0", "-007", "--1"]) expect(contracts.SignedUsdNano.safeParse(invalid).success, invalid).toBe(false);
  });

  it("gives receipts no field that could carry content", () => {
    const receiptKeys = Object.keys(contracts.CostReceipt.shape);
    const attemptKeys = Object.keys(contracts.UsageAttempt.shape);
    for (const key of [...receiptKeys, ...attemptKeys]) {
      expect(key).not.toMatch(/text|prompt|content|message|body/i);
    }
  });

  it("bounds text content", () => {
    const text = "a".repeat(contracts.MAX_TEXT_LENGTH + 1);
    expect(contracts.EvaluationContent.safeParse({ type: "text", text }).success).toBe(false);
  });
});
