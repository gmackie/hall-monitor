import { ACTIVE_POINTER_KEY, ActivePointer, type ConfigRelease, ConfigReleaseError, releaseObjectKey, verifyConfigRelease } from "@gmacko/hall-monitor-config-release";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

/** How long a verified release (or its absence) is reused before the pointer is read again. */
export const CONFIG_RELEASE_TTL_MS = 60_000;

/** The release the Worker serves, verified against its digest. */
export interface ActiveRelease {
  readonly digest: string;
  readonly release: ConfigRelease;
}

let active: ActiveRelease | undefined;
let checkedAt = Number.NEGATIVE_INFINITY;

/** Why a release was refused: fixed codes for `config.release_invalid`. */
export type ReleaseFailure = "pointer_invalid" | "object_missing" | "release_invalid" | "digest_mismatch" | "release_id_mismatch" | "unavailable";

/** The active release, if the last refresh found and verified one. Synchronous, for `loadConfig`. */
export function activeConfigRelease(): ActiveRelease | undefined {
  return active;
}

/**
 * Refreshes the active config release from KV (`active` pointer) and R2 (`releases/<digest>.json`)
 * at most once a minute per isolate. It never throws. No bindings or no pointer means no release
 * (the Worker reads its secrets as before). Any other failure (a bad pointer, a missing or
 * tampered object, a release id that does not match) drops the cached release, logs
 * `config.release_invalid` with a fixed reason, and falls back to the secrets until a later
 * refresh succeeds: a broken release can make the Worker use its break-glass secrets, never an
 * unverified configuration.
 */
export async function refreshConfigRelease(env: Pick<Env, "CONFIG_POINTER" | "CONFIG_RELEASES">, now = Date.now()): Promise<void> {
  if (env.CONFIG_POINTER === undefined || env.CONFIG_RELEASES === undefined) {
    active = undefined;
    return;
  }
  if (now - checkedAt < CONFIG_RELEASE_TTL_MS) return;
  checkedAt = now;
  const fail = (reason: ReleaseFailure) => {
    active = undefined;
    log("error", "config.release_invalid", { reason });
  };
  let pointerText: string | null;
  try {
    pointerText = await env.CONFIG_POINTER.get(ACTIVE_POINTER_KEY);
  } catch {
    return fail("unavailable");
  }
  if (pointerText === null) {
    active = undefined;
    return;
  }
  let pointer: ActivePointer;
  try {
    const parsed = ActivePointer.safeParse(JSON.parse(pointerText));
    if (!parsed.success) return fail("pointer_invalid");
    pointer = parsed.data;
  } catch {
    return fail("pointer_invalid");
  }
  if (active?.digest === pointer.digest && active.release.releaseId === pointer.releaseId) return;
  let body: string;
  try {
    const object = await env.CONFIG_RELEASES.get(releaseObjectKey(pointer.digest));
    if (object === null) return fail("object_missing");
    body = await object.text();
  } catch {
    return fail("unavailable");
  }
  let release: ConfigRelease;
  try {
    release = await verifyConfigRelease(body, pointer.digest);
  } catch (error) {
    return fail(error instanceof ConfigReleaseError && error.reason === "digest_mismatch" ? "digest_mismatch" : "release_invalid");
  }
  if (release.releaseId !== pointer.releaseId) return fail("release_id_mismatch");
  active = { digest: pointer.digest, release };
}

/** Test seam: forget the cached release and the last check time. */
export function resetConfigReleaseCache(): void {
  active = undefined;
  checkedAt = Number.NEGATIVE_INFINITY;
}
