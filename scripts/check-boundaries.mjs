// Hall Monitor is product-neutral and public: shared packages may not import product code,
// and no file may reference a private product package.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [/from\s+["']@playtrek\//, /from\s+["']@schoolos\//, /from\s+["']@gadgets\//, /require\(["']@playtrek\//];
const roots = ["packages", "apps"];
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|js|mjs|json)$/.test(name)) {
      const text = readFileSync(path, "utf8");
      for (const pattern of FORBIDDEN) if (pattern.test(text)) failures.push(`${path}: ${pattern}`);
    }
  }
}

for (const root of roots) {
  try { walk(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (failures.length > 0) {
  console.error("Product imports are not allowed in hall-monitor:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("boundaries ok");
