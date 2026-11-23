import { describe, expect, it } from "vitest";
import { ActivePointer, type ConfigRelease, ConfigReleaseError, configReleaseDigest, parseConfigRelease, releaseObjectKey, serializeConfigRelease, verifyConfigRelease } from "../src/index.ts";

const release: ConfigRelease = {
  schemaVersion: "1.0",
  releaseId: "rel_1",
  createdAt: "2026-11-22T00:00:00Z",
  author: "author@example.test",
  approver: "approver@example.test",
  overlays: { playtrek: { "student-6-8": { revision: "pt:1", outputModeration: "required" } } },
  tenantModes: { playtrek: "shadow", "playtrek-beta": "enforce" },
};

describe("config releases", () => {
  it("digests independently of key order and round-trips through storage", async () => {
    const digest = await configReleaseDigest(release);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const { tenantModes, overlays, ...rest } = release;
    const reordered = JSON.parse(JSON.stringify({ tenantModes, overlays, ...rest }));
    expect(await configReleaseDigest(reordered)).toBe(digest);
    expect(await verifyConfigRelease(serializeConfigRelease(release), digest)).toEqual(release);
    expect(releaseObjectKey(digest)).toBe(`releases/${digest}.json`);
  });

  it("refuses a tampered body", async () => {
    const digest = await configReleaseDigest(release);
    const tampered = serializeConfigRelease(release).replace('"shadow"', '"enforce"');
    await expect(verifyConfigRelease(tampered, digest)).rejects.toThrow(new ConfigReleaseError("digest_mismatch"));
    await expect(verifyConfigRelease("{not json", digest)).rejects.toThrow(new ConfigReleaseError("invalid"));
  });

  it("refuses unknown keys, governance, waivers and a self-approved release", () => {
    expect(() => parseConfigRelease({ ...release, extra: 1 })).toThrow(new ConfigReleaseError("invalid"));
    expect(() => parseConfigRelease({ ...release, governance: {} })).toThrow(new ConfigReleaseError("forbidden_key"));
    expect(() => parseConfigRelease({ ...release, overlays: { t: { p: { revision: "r", HM_MODEL_ENFORCE_WAIVERS: ["clairic"] } } } })).toThrow(new ConfigReleaseError("forbidden_key"));
    expect(() => parseConfigRelease({ ...release, approver: "Author@Example.test" })).toThrow(new ConfigReleaseError("same_person"));
  });

  it("parses the active pointer", () => {
    expect(ActivePointer.safeParse({ releaseId: "rel_1", digest: `sha256:${"a".repeat(64)}` }).success).toBe(true);
    expect(ActivePointer.safeParse({ releaseId: "rel_1", digest: "sha256:zz" }).success).toBe(false);
  });
});
