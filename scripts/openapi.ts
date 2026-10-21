// Writes the Worker's OpenAPI document, generated from the zod contracts, to
// apps/worker/openapi.json; with --check, fails instead when the committed file has drifted.
//
// Usage: pnpm openapi [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openApiJson } from "../apps/worker/src/openapi.ts";

const target = resolve(import.meta.dirname, "../apps/worker/openapi.json");
const { values } = parseArgs({ options: { check: { type: "boolean" } } });
const generated = openApiJson();

if (values.check) {
  let committed: string | undefined;
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    committed = undefined;
  }
  if (committed !== generated) {
    console.error("apps/worker/openapi.json is out of date with the contracts; run `pnpm openapi` and commit the result.");
    process.exit(1);
  }
  console.log("openapi.json up to date");
} else {
  writeFileSync(target, generated);
  console.log(`wrote ${target}`);
}
