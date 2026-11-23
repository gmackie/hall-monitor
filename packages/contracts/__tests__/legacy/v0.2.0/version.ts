import { z } from "zod";

/** The wire schema version this package emits. */
export const SCHEMA_VERSION = "1.0";

/**
 * Every schema version this package can read. A version is listed here only while its documents
 * still parse with the current schemas; removing one is a breaking change.
 */
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0"] as const;

/** A `major.minor` schema version string, as carried in every request and result. */
export const SchemaVersion = z.string().regex(/^\d{1,3}\.\d{1,3}$/);
/** A `major.minor` schema version string, as carried in every request and result. */
export type SchemaVersion = z.infer<typeof SchemaVersion>;

/**
 * Whether a document written at `version` can be read by this package.
 *
 * Minor versions only add optional fields, so a supported major accepts any minor up to the
 * newest supported one. A newer minor is refused rather than parsed with its new fields silently
 * dropped, and any other major is incompatible.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  return SUPPORTED_SCHEMA_VERSIONS.some((supported) => {
    const known = parseVersion(supported);
    return known !== null && known.major === parsed.major && parsed.minor <= known.minor;
  });
}

function parseVersion(version: string): { major: number; minor: number } | null {
  if (!SchemaVersion.safeParse(version).success) return null;
  const [major, minor] = version.split(".").map(Number);
  return major === undefined || minor === undefined ? null : { major, minor };
}
