import type { PolicyProfile } from "./profile.ts";

/** A tenant's explicit permissions for shadow mode, from service configuration. */
export interface ShadowPermissions {
  /**
   * Lets shadow mode apply to student-facing profiles whose input moderation is required. Off by
   * default; see {@link isShadowable}.
   */
  readonly allowStudentShadow?: boolean;
}

/** Why a profile may or may not run in shadow mode. */
export type ShadowEligibility =
  | { readonly shadowable: true }
  | { readonly shadowable: false; readonly reason: "student_required_moderation" };

/**
 * Whether results under `profile` may be shadowed (returned as `allow` with the would-be decision
 * recorded) rather than enforced.
 *
 * A student-facing profile whose input moderation is `required` is not shadowable unless the
 * tenant is explicitly configured with `allowStudentShadow`. Such a profile exists because a
 * learner must not see unmoderated content: shadowing it would let a block or hold through to a
 * child while the service reports itself as moderating, which is the failure required moderation
 * forbids. A tenant may opt in only for traffic where no learner is exposed, such as synthetic
 * fixtures or a staff-only pilot, and only under the M7 launch gates. Shadow mode never
 * suppresses `support`, whatever the profile: see `shadowResult` in the core package.
 */
export function shadowEligibility(profile: PolicyProfile, permissions: ShadowPermissions = {}): ShadowEligibility {
  if (profile.studentFacing && profile.inputModeration === "required" && permissions.allowStudentShadow !== true) {
    return { shadowable: false, reason: "student_required_moderation" };
  }
  return { shadowable: true };
}

/** Shorthand for `shadowEligibility(profile, permissions).shadowable`. */
export function isShadowable(profile: PolicyProfile, permissions: ShadowPermissions = {}): boolean {
  return shadowEligibility(profile, permissions).shadowable;
}
