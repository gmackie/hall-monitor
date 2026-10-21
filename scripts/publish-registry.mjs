// Publishes the tarballs scripts/pack-release.mjs wrote to dist/release/ to the ForgeGraph package
// registry, dependencies first. A version the registry already has is left alone, so re-running a
// release job is safe. Needs FORGEGRAPH_REGISTRY_TOKEN; the token is written only to a temporary
// npm config that is deleted afterwards.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REGISTRY = process.env.FORGEGRAPH_REGISTRY_URL ?? "https://npm.forgegraf.com/";
const token = process.env.FORGEGRAPH_REGISTRY_TOKEN;
if (!token) throw new Error("FORGEGRAPH_REGISTRY_TOKEN is not set");

const out = resolve(import.meta.dirname, "..", "dist", "release");
const { version, packages } = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));

const configDir = mkdtempSync(join(tmpdir(), "hm-publish-"));
const userconfig = join(configDir, ".npmrc");
const host = new URL(REGISTRY).host;
writeFileSync(userconfig, `@gmacko:registry=${REGISTRY}\n//${host}/:_authToken=${token}\n`, { mode: 0o600 });
const npm = (args) => execFileSync("npm", [...args, "--userconfig", userconfig, "--registry", REGISTRY], { encoding: "utf8" });

try {
  // manifest.json lists packages in pack order, which pack-release.mjs keeps in dependency order.
  for (const [name, tarball] of Object.entries(packages)) {
    let published = false;
    try {
      published = npm(["view", `${name}@${version}`, "version"]).trim() === version;
    } catch {
      // Not found: publish it.
    }
    if (published) {
      console.log(`${name}@${version} already published`);
      continue;
    }
    npm(["publish", join(out, tarball), "--access", "restricted"]);
    console.log(`published ${name}@${version}`);
  }
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
