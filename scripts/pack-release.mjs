// Packs every publishable package into dist/release/ with `pnpm pack`, which rewrites
// `workspace:*` and `catalog:` specifiers to concrete versions, and writes
// dist/release/manifest.json (package name -> tarball file name). Publishes nothing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Packages consumers may depend on, in dependency order. test-fixtures and the worker stay private. */
export const PUBLISHABLE = ["contracts", "costing", "policy", "evaluators", "clef", "core", "client"];

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const packages = {};
let version;
for (const dir of PUBLISHABLE) {
  const cwd = join(root, "packages", dir);
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  if (manifest.private === true) throw new Error(`${manifest.name} is private`);
  if (version !== undefined && manifest.version !== version) {
    throw new Error(`${manifest.name}@${manifest.version} does not match release version ${version}`);
  }
  version = manifest.version;
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd, stdio: ["ignore", "ignore", "inherit"] });
  const tarball = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
  if (!existsSync(join(out, tarball))) throw new Error(`pnpm pack did not produce ${tarball}`);
  packages[manifest.name] = tarball;
}

// A packed manifest must never keep a workspace-only specifier: it would not resolve elsewhere.
for (const tarball of Object.values(packages)) {
  const packed = execFileSync("tar", ["-xOzf", join(out, tarball), "package/package.json"], { encoding: "utf8" });
  if (/"(workspace|catalog):/.test(packed)) throw new Error(`${tarball} still contains workspace: or catalog: specifiers`);
}

writeFileSync(join(out, "manifest.json"), JSON.stringify({ version, packages }, null, 2) + "\n");
console.log(`packed ${Object.keys(packages).length} packages at ${version} into dist/release`);
