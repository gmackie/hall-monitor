import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import committed from "../openapi.json";
import { buildOpenApiDocument, openApiJson } from "../src/openapi.ts";

const BASE = "https://hall-monitor.test";

/** Every `$ref` target in a JSON value. */
function refs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refs);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => (key === "$ref" && typeof member === "string" ? [member] : refs(member)));
}

describe("GET /v1/openapi.json", () => {
  it("serves the committed document without authentication", async () => {
    const response = await SELF.fetch(`${BASE}/v1/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe(openApiJson());
    // The same drift check `pnpm openapi:check` runs in CI.
    expect(openApiJson()).toBe(`${JSON.stringify(committed, null, 2)}\n`);
  });

  it("rejects other methods", async () => {
    expect((await SELF.fetch(`${BASE}/v1/openapi.json`, { method: "POST" })).status).toBe(405);
  });
});

describe("buildOpenApiDocument", () => {
  const document = buildOpenApiDocument() as {
    openapi: string;
    paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };

  it("is OpenAPI 3.1 and documents every route the Worker serves", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual(
      ["/v1/capabilities", "/v1/evaluations", "/v1/evaluations:batch", "/v1/health", "/v1/openapi.json", "/v1/ready", "/v1/receipts/{evaluationId}"].sort(),
    );
    expect(document.paths["/v1/health"]!.get!.security).toEqual([]);
    expect(document.paths["/v1/openapi.json"]!.get!.security).toEqual([]);
    expect(document.paths["/v1/evaluations"]!.post!.security).toBeUndefined();
  });

  it("resolves every $ref to a component schema", () => {
    const targets = new Set(refs(document));
    expect(targets.size).toBeGreaterThan(0);
    for (const target of targets) {
      const name = /^#\/components\/schemas\/(.+)$/.exec(target)?.[1];
      expect(name, target).toBeDefined();
      expect(document.components.schemas[name!], target).toBeDefined();
    }
  });

  it("keeps per-schema JSON Schema headers out of components", () => {
    for (const schema of Object.values(document.components.schemas)) {
      expect(schema).not.toHaveProperty("$schema");
      expect(schema).not.toHaveProperty("$id");
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(document));
  });
});
