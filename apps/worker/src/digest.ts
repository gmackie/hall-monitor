/**
 * Serializes JSON-compatible data canonically: object keys sorted, no whitespace, `undefined`
 * members dropped. Two requests with the same meaning therefore have the same digest whatever
 * the caller's key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
}

/** The lowercase hex SHA-256 of a value's canonical JSON. */
export async function requestDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
