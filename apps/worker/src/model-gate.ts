import { MODEL_REGISTRY } from "@gmacko/hall-monitor-costing";
import type { PolicyProfile } from "@gmacko/hall-monitor-policy";
import type { Env } from "./env.ts";

/**
 * Applies the model gate to a profile's routing: a family whose models are all in `preview` runs
 * in shadow, whatever the profile asks, unless `HM_MODEL_ENFORCE_WAIVERS` (a JSON array of family
 * names) records the owner's waiver for it. Shadowing a family only removes findings that never
 * decided before routing existed, so this cannot weaken a floor's Clef enforcement.
 */
export function gatedProfile(profile: PolicyProfile, env: Pick<Env, "HM_MODEL_ENFORCE_WAIVERS">): PolicyProfile {
  if (profile.routing === undefined) return profile;
  const waivers = parseWaivers(env.HM_MODEL_ENFORCE_WAIVERS);
  let changed = false;
  const routing = { ...profile.routing };
  for (const family of ["clef", "clairic"] as const) {
    const entry = routing[family];
    const preview = MODEL_REGISTRY.filter((model) => model.family === family).every((model) => model.status === "preview");
    if (entry?.mode === "enforce" && preview && !waivers.has(family)) {
      routing[family] = { ...entry, mode: "shadow" };
      changed = true;
    }
  }
  return changed ? { ...profile, routing } : profile;
}

function parseWaivers(raw: string | undefined): Set<string> {
  if (raw === undefined || raw === "") return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}
