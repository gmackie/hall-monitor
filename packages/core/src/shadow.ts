import { EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { type PolicyProfile, SYSTEM_REASON_CODES, shadowEligibility } from "@gmacko/hall-monitor-policy";
import type { EnforcementOptions } from "./evaluate.ts";

/**
 * Applies the host's enforcement mode to an enforced result.
 *
 * In `shadow` mode, when the profile is shadowable (see `shadowEligibility` in the policy
 * package), the caller receives `allow` with the single reason code `hall_monitor.shadow`, and the
 * would-be decision and its reason codes are recorded in `result.shadow`. Findings, `uncertain`,
 * `degraded` and the receipt are left as evaluated: they describe what happened, not what to do.
 *
 * Two outcomes are never shadowed and come back enforced, without a `shadow` field:
 * - `support`, because it routes a person in distress to help rather than restricting anything,
 *   and holding that back to measure it would be the harm shadow mode exists to avoid;
 * - any result under a profile that may not be shadowed, reported through `onShadowRefused`.
 *
 * An already-`allow` result is still marked as shadowed, so shadow traffic is identifiable.
 */
export function applyEnforcement(result: EvaluationResult, profile: PolicyProfile, enforcement: EnforcementOptions | undefined): EvaluationResult {
  if (enforcement === undefined || enforcement.mode === "enforce") return result;
  if (!shadowEligibility(profile, enforcement).shadowable) {
    enforcement.onShadowRefused?.(profile);
    return result;
  }
  return shadowResult(result);
}

/** The shadow form of an enforced result; a `support` result is returned unchanged. */
export function shadowResult(result: EvaluationResult): EvaluationResult {
  if (result.decision === "support" || result.shadow !== undefined) return result;
  return EvaluationResult.parse({
    ...result,
    decision: "allow",
    reasonCodes: [SYSTEM_REASON_CODES.shadow],
    shadow: { decision: result.decision, reasonCodes: result.reasonCodes },
  });
}
