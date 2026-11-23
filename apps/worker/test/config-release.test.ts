import { env, SELF } from "cloudflare:test";
import { ACTIVE_POINTER_KEY, type ConfigRelease, configReleaseDigest, releaseObjectKey, serializeConfigRelease } from "@gmacko/hall-monitor-config-release";
import { Capabilities } from "@gmacko/hall-monitor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeConfigRelease, refreshConfigRelease, resetConfigReleaseCache } from "../src/config-release.ts";
import { loadConfig, lookupPolicy, tenantMode } from "../src/config.ts";
import { call } from "./helpers.ts";
import { mintToken } from "./tokens.ts";

const BASE = "https://hall-monitor.test";
let lines: string[] = [];

function release(overrides: Partial<ConfigRelease> = {}): ConfigRelease {
  return {
    schemaVersion: "1.0", releaseId: `rel_${crypto.randomUUID().slice(0, 8)}`, createdAt: "2026-11-22T00:00:00Z",
    author: "author@example.test", approver: "approver@example.test",
    overlays: { tenant_overlay: { educator: { revision: "district-7:4", outputModeration: "required" } } },
    ...overrides,
  };
}

async function publish(value: ConfigRelease, options: { body?: string; digest?: string; releaseId?: string } = {}) {
  const digest = options.digest ?? await configReleaseDigest(value);
  await env.CONFIG_RELEASES!.put(releaseObjectKey(digest), options.body ?? serializeConfigRelease(value));
  await env.CONFIG_POINTER!.put(ACTIVE_POINTER_KEY, JSON.stringify({ releaseId: options.releaseId ?? value.releaseId, digest }));
  return digest;
}

async function profiles(tenant: string) {
  const response = await SELF.fetch(`${BASE}/v1/capabilities`, call("GET", await mintToken("educateos", { tenant })));
  return Capabilities.parse(await response.json()).policyProfiles;
}

beforeEach(() => {
  resetConfigReleaseCache();
  lines = [];
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
});
afterEach(async () => {
  resetConfigReleaseCache();
  await env.CONFIG_POINTER!.delete(ACTIVE_POINTER_KEY);
  vi.restoreAllMocks();
});

describe("config releases in the evaluation Worker", () => {
  it("leaves behaviour unchanged when no pointer is set", async () => {
    expect((await profiles("tenant_overlay")).find((p) => p.id === "educator")?.revision).toBe("district-7:3");
    expect(activeConfigRelease()).toBeUndefined();
  });

  it("serves an active release's overlays in place of HM_POLICY_OVERLAYS", async () => {
    await publish(release());
    expect((await profiles("tenant_overlay")).find((p) => p.id === "educator")?.revision).toBe("district-7:4");
  });

  it("replaces tenant modes only when the release carries them", async () => {
    await publish(release());
    await refreshConfigRelease(env, Date.now() + 120_000);
    expect(tenantMode(loadConfig(env), "tenant_shadow").mode).toBe("shadow");
    resetConfigReleaseCache();
    await publish(release({ tenantModes: { tenant_enforced: "shadow" } }));
    await refreshConfigRelease(env);
    const config = loadConfig(env);
    expect(tenantMode(config, "tenant_enforced").mode).toBe("shadow");
    expect(tenantMode(config, "tenant_shadow").mode).toBe("enforce");
  });

  it("falls back to the secrets when the body is tampered, the digest is wrong or the id differs", async () => {
    const good = release();
    for (const options of [
      { body: serializeConfigRelease(good).replace("district-7:4", "district-7:9") },
      { digest: `sha256:${"0".repeat(64)}` },
      { releaseId: "rel_other" },
    ]) {
      resetConfigReleaseCache();
      await publish(good, options);
      expect((await profiles("tenant_overlay")).find((p) => p.id === "educator")?.revision).toBe("district-7:3");
    }
    resetConfigReleaseCache();
    await env.CONFIG_POINTER!.put(ACTIVE_POINTER_KEY, JSON.stringify({ releaseId: good.releaseId, digest: `sha256:${"1".repeat(64)}` }));
    expect((await profiles("tenant_overlay")).find((p) => p.id === "educator")?.revision).toBe("district-7:3");
    resetConfigReleaseCache();
    await env.CONFIG_POINTER!.put(ACTIVE_POINTER_KEY, "not json");
    expect((await profiles("tenant_overlay")).find((p) => p.id === "educator")?.revision).toBe("district-7:3");
    expect(lines.filter((line) => line.includes("config.release_invalid")).map((line) => JSON.parse(line).reason))
      .toEqual(["digest_mismatch", "digest_mismatch", "release_id_mismatch", "object_missing", "pointer_invalid"]);
  });

  it("still clamps a floor-weakening release to the floor", async () => {
    await publish(release({ overlays: { tenant_weak: { "student-9-12": { revision: "weak:1", inputModeration: "off", studentFacing: false } } } }));
    await refreshConfigRelease(env);
    const profile = lookupPolicy(loadConfig(env), "tenant_weak", "student-9-12", "weak:1");
    expect(profile).toMatchObject({ inputModeration: "required", studentFacing: true });
  });

  it("rechecks the pointer at most once a minute", async () => {
    const now = Date.now();
    await refreshConfigRelease(env, now);
    await publish(release());
    await refreshConfigRelease(env, now + 1_000);
    expect(activeConfigRelease()).toBeUndefined();
    await refreshConfigRelease(env, now + 61_000);
    expect(activeConfigRelease()).toBeDefined();
  });
});
