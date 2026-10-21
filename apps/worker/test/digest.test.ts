import { describe, expect, it } from "vitest";
import { requestDigest } from "../src/digest.ts";

const SECRET = "a".repeat(32);

describe("requestDigest", () => {
  it("is stable across key order", async () => {
    expect(await requestDigest({ a: 1, b: { c: "x", d: 2 } }, SECRET)).toBe(await requestDigest({ b: { d: 2, c: "x" }, a: 1 }, SECRET));
  });

  it("depends on the secret, so stored digests cannot be checked against guessed text without it", async () => {
    const request = { content: { type: "text", text: "yes" } };
    expect(await requestDigest(request, SECRET)).not.toBe(await requestDigest(request, "b".repeat(32)));
  });

  it("is a lowercase hex HMAC-SHA-256", async () => {
    expect(await requestDigest({}, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});
