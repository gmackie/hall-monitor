import { type Decision, type DegradedReason, type EvaluationContext, Finding } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import type { PolicyProfile } from "./profile.ts";
import { decisionRank, strongerDecision } from "./strictness.ts";

/**
 * Version of the precedence table below. Bump it whenever any input can map to a different
 * decision, so stored results can be replayed against the table that produced them.
 */
export const RESOLVER_VERSION = "resolver-1.0.0";

/** Reason codes the resolver adds itself, independent of any evaluator. */
export const SYSTEM_REASON_CODES = Object.freeze({
  unavailable: "hall_monitor.unavailable",
  deterministicOnly: "hall_monitor.deterministic_only",
  uncertain: "hall_monitor.uncertain",
  budgetExhausted: "hall_monitor.budget_exhausted",
});

/** Conditions of the evaluation itself rather than of the content. */
export interface ResolutionFlags {
  /** The classifier answered, but not confidently. */
  readonly uncertain?: boolean;
  /** The classifier was required or requested but gave no answer. */
  readonly classifierUnavailable?: boolean;
  /** The classifier gave no answer because it timed out; implies `classifierUnavailable`. */
  readonly classifierTimedOut?: boolean;
  /** The safety budget could not fund classification. */
  readonly budgetExhausted?: boolean;
}

/** The parts of the request context the resolver reads. */
export type ResolutionContext = Pick<EvaluationContext, "audience" | "graded">;

/** The decision and the evidence for it. */
export interface Resolution {
  readonly decision: Decision;
  /** Every reason code, strongest decision first, then alphabetical; no duplicates. */
  readonly reasonCodes: readonly string[];
  readonly uncertain: boolean;
  readonly degraded?: DegradedReason;
  readonly resolverVersion: string;
}

const Findings = z.array(Finding);

/**
 * Turns findings into one decision with a fixed precedence table (resolver-1.0.0):
 *
 * | Finding severity            | Decision                                                  |
 * |-----------------------------|-----------------------------------------------------------|
 * | `support`                   | `support`: outranks every other outcome                   |
 * | `block` / `hold`            | `block` / `hold`                                          |
 * | `warn`, academic-integrity  | `coach` when scaffolded, or contextual and graded; else `allow` |
 * | `warn`, any other category  | `coach`                                                   |
 * | `info`                      | `allow`                                                   |
 *
 * A profile's `actionOverrides` then raise (never lower) the outcome for their reason codes.
 * System conditions add their own outcomes: an exhausted budget blocks; an unavailable
 * classifier holds under `fail_closed` and is reported as degraded under `deterministic_only`;
 * an uncertain classifier holds under `fail_closed`. The final decision is the highest-precedence
 * outcome, so a distress disclosure reaches `support` even alongside block findings, whose reason
 * codes are still reported.
 *
 * The result depends only on the profile, the findings as a set, the context and the flags, never
 * on finding order. Findings are validated first, so an unknown severity or category throws
 * rather than inventing an action.
 */
export function resolveDecision(
  profile: PolicyProfile,
  findings: readonly unknown[],
  context: ResolutionContext,
  flags: ResolutionFlags = {},
): Resolution {
  const outcomes = new Map<string, Decision>();
  const record = (reasonCode: string, decision: Decision) =>
    outcomes.set(reasonCode, strongerDecision(outcomes.get(reasonCode) ?? "allow", decision));

  for (const finding of Findings.parse(findings)) {
    const decision = findingDecision(profile, finding, context);
    record(finding.reasonCode, strongerDecision(decision, profile.actionOverrides?.[finding.reasonCode] ?? "allow"));
  }

  const failClosed = profile.failureMode.classifierUnavailable === "fail_closed";
  const unavailable = flags.classifierUnavailable === true || flags.classifierTimedOut === true;
  let degraded: DegradedReason | undefined;
  if (flags.budgetExhausted) {
    record(SYSTEM_REASON_CODES.budgetExhausted, "block");
    degraded = "budget_exhausted";
  }
  if (unavailable) {
    record(failClosed ? SYSTEM_REASON_CODES.unavailable : SYSTEM_REASON_CODES.deterministicOnly, failClosed ? "hold" : "allow");
    degraded ??= flags.classifierTimedOut ? "classifier_timeout" : "classifier_unavailable";
  } else if (flags.uncertain && failClosed) {
    record(SYSTEM_REASON_CODES.uncertain, "hold");
  }

  const ranked = [...outcomes].sort(([codeA, a], [codeB, b]) => decisionRank(b) - decisionRank(a) || (codeA < codeB ? -1 : 1));
  const resolution: Resolution = {
    decision: ranked.reduce<Decision>((best, [, decision]) => strongerDecision(best, decision), "allow"),
    reasonCodes: ranked.map(([code]) => code),
    uncertain: flags.uncertain === true || unavailable,
    resolverVersion: RESOLVER_VERSION,
  };
  return degraded === undefined ? resolution : { ...resolution, degraded };
}

function findingDecision(profile: PolicyProfile, finding: Finding, context: ResolutionContext): Decision {
  switch (finding.severity) {
    case "support":
    case "block":
    case "hold":
      return finding.severity;
    case "info":
      return "allow";
    case "warn":
      return finding.category === "academic-integrity" ? academicIntegrityDecision(profile, context) : "coach";
  }
}

function academicIntegrityDecision(profile: PolicyProfile, context: ResolutionContext): Decision {
  switch (profile.answerAssistance) {
    case "scaffolded":
      return "coach";
    case "contextual":
      return context.graded === true ? "coach" : "allow";
    case "direct":
      return "allow";
  }
}
