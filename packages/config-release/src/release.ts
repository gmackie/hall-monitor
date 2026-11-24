import { EnforcementMode, OpaqueId, Timestamp } from "@gmacko/hall-monitor-contracts";
import { PolicyOverlay } from "@gmacko/hall-monitor-policy";
import { z } from "zod";

/**
 * One tenant's enforcement-mode setting: a bare mode, or a mode with explicit permission to shadow
 * student-facing profiles whose input moderation is required. The one definition shared by the
 * Worker's `HM_TENANT_MODES` secret and config releases.
 */
export const TenantModeSetting = z.union([
  EnforcementMode,
  z.strictObject({ mode: EnforcementMode, allowStudentShadow: z.boolean().optional() }),
]);
export type TenantModeSetting = z.infer<typeof TenantModeSetting>;

/** Enforcement mode by tenant. Tenants not listed are enforced. */
export const TenantModes = z.record(OpaqueId, TenantModeSetting);
export type TenantModes = z.infer<typeof TenantModes>;

/** Policy overlays by tenant, then profile id: the shape of `HM_POLICY_OVERLAYS`. */
export const ReleaseOverlays = z.record(OpaqueId, z.record(OpaqueId, PolicyOverlay));
export type ReleaseOverlays = z.infer<typeof ReleaseOverlays>;

/** Keys that must never appear in a release: governance and model waivers stay Worker secrets. */
const FORBIDDEN_KEYS = new Set(["HM_GOVERNANCE", "governance", "waivers", "HM_MODEL_ENFORCE_WAIVERS"]);

/**
 * An immutable config release (HM-34): the complete set of tenant policy overlays and, when the
 * admin set any, tenant enforcement modes. It is addressed by its digest. The evaluation Worker
 * still applies every overlay tighten-only against the built-in floors, so a release can never
 * weaken a floor; governance and model waivers are never part of one.
 */
export const ConfigRelease = z.strictObject({
  schemaVersion: z.literal("1.0"),
  releaseId: OpaqueId,
  createdAt: Timestamp,
  /** Who published it. */
  author: z.string().min(3).max(320),
  /** Who approved the revisions it carries; never the author. */
  approver: z.string().min(3).max(320),
  overlays: ReleaseOverlays,
  /** Absent: the Worker keeps `HM_TENANT_MODES`. Present: it replaces it entirely. */
  tenantModes: TenantModes.optional(),
});
export type ConfigRelease = z.infer<typeof ConfigRelease>;

/** The KV value (key `active`) naming the release the Worker serves. */
export const ActivePointer = z.strictObject({ releaseId: OpaqueId, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
export type ActivePointer = z.infer<typeof ActivePointer>;

/** The KV key of the active pointer. */
export const ACTIVE_POINTER_KEY = "active";

/** Where a release with `digest` lives in R2. */
export function releaseObjectKey(digest: string): string {
  return `releases/${digest}.json`;
}

/** Raised when a release fails to parse or verify; `reason` is a fixed code, safe to log. */
export class ConfigReleaseError extends Error {
  readonly reason: "invalid" | "forbidden_key" | "same_person" | "digest_mismatch";

  constructor(reason: ConfigReleaseError["reason"]) {
    super(`config release ${reason}`);
    this.reason = reason;
  }
}

/** JSON with object keys sorted; arrays keep their order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([k, v]) => FORBIDDEN_KEYS.has(k) || hasForbiddenKey(v));
  return false;
}

/** Parses and checks a release: strict schema, no governance or waiver keys, author ≠ approver. */
export function parseConfigRelease(input: unknown): ConfigRelease {
  if (hasForbiddenKey(input)) throw new ConfigReleaseError("forbidden_key");
  const parsed = ConfigRelease.safeParse(input);
  if (!parsed.success) throw new ConfigReleaseError("invalid");
  if (parsed.data.author.toLowerCase() === parsed.data.approver.toLowerCase()) throw new ConfigReleaseError("same_person");
  return parsed.data;
}

/** `sha256:` + hex SHA-256 over `hall-monitor/config-release/v1\n` + the canonical release (WebCrypto). */
export async function configReleaseDigest(release: ConfigRelease): Promise<string> {
  const bytes = new TextEncoder().encode(`hall-monitor/config-release/v1\n${canonical(release)}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The bytes a release is stored as. */
export function serializeConfigRelease(release: ConfigRelease): string {
  return canonical(release);
}

/**
 * Parses stored bytes (or a parsed value) and checks they digest to `expectedDigest`. Returns the
 * release, or throws a {@link ConfigReleaseError}.
 */
export async function verifyConfigRelease(body: string | unknown, expectedDigest: string): Promise<ConfigRelease> {
  let value: unknown = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      throw new ConfigReleaseError("invalid");
    }
  }
  const release = parseConfigRelease(value);
  if ((await configReleaseDigest(release)) !== expectedDigest) throw new ConfigReleaseError("digest_mismatch");
  return release;
}
