import type { EvaluationKind, EvaluationRequest, Finding, UsageAttempt } from "@gmacko/hall-monitor-contracts";
import type { PolicyProfile, ResolutionFlags } from "@gmacko/hall-monitor-policy";

/** What an evaluator may read besides the request. */
export interface EvaluatorContext {
  /** The resolved policy profile the request is evaluated under. */
  readonly profile: PolicyProfile;
  /** Aborted when the evaluation is abandoned; long-running evaluators must stop. */
  readonly signal: AbortSignal;
}

/** Conditions an evaluator reports about its own run, which the resolver turns into outcomes. */
export type EvaluatorSignals = Pick<ResolutionFlags, "uncertain" | "classifierUnavailable" | "classifierTimedOut">;

/**
 * An evaluator's output. Usage is kept apart from findings so a deterministic evaluator simply
 * returns no attempts, and a model-backed one reports every provider call it made.
 */
export interface EvaluatorOutput {
  readonly findings: readonly Finding[];
  readonly attempts: readonly UsageAttempt[];
  readonly signals?: EvaluatorSignals;
}

/** A pluggable evaluator. Findings must never include the text they matched. */
export interface EvaluatorPlugin {
  readonly id: string;
  readonly version: string;
  readonly supportedKinds: readonly EvaluationKind[];
  evaluate(request: EvaluationRequest, context: EvaluatorContext): Promise<EvaluatorOutput>;
}

/** A finding before the evaluator stamps its id and version on it. */
export type FindingDraft = Omit<Finding, "evaluatorId" | "evaluatorVersion">;

/** Definition of a synchronous, content-only evaluator. */
export interface DeterministicEvaluatorDefinition {
  readonly id: string;
  readonly version: string;
  readonly supportedKinds: readonly EvaluationKind[];
  inspect(request: EvaluationRequest, context: EvaluatorContext): readonly FindingDraft[];
}

/** Wraps a synchronous inspector as an {@link EvaluatorPlugin} that makes no provider calls. */
export function deterministicEvaluator(definition: DeterministicEvaluatorDefinition): EvaluatorPlugin {
  const { id, version, supportedKinds } = definition;
  return {
    id,
    version,
    supportedKinds,
    async evaluate(request, context) {
      const findings = definition.inspect(request, context).map((draft) => ({ evaluatorId: id, evaluatorVersion: version, ...draft }));
      return { findings, attempts: [] };
    },
  };
}

/** A named, versioned set of evaluators that ships and is pinned together. */
export interface EvaluatorBundle {
  readonly id: string;
  readonly revision: string;
  readonly plugins: readonly EvaluatorPlugin[];
}

/**
 * Runs every plugin that supports the request's kind and merges their outputs in plugin order.
 * Signals are combined by OR.
 */
export async function runPlugins(
  plugins: readonly EvaluatorPlugin[],
  request: EvaluationRequest,
  context: EvaluatorContext,
): Promise<Required<EvaluatorOutput>> {
  const applicable = plugins.filter((plugin) => plugin.supportedKinds.includes(request.evaluationKind));
  const outputs = await Promise.all(applicable.map((plugin) => plugin.evaluate(request, context)));
  const signals: { -readonly [K in keyof EvaluatorSignals]: EvaluatorSignals[K] } = {};
  for (const output of outputs) {
    for (const key of ["uncertain", "classifierUnavailable", "classifierTimedOut"] as const) {
      if (output.signals?.[key]) signals[key] = true;
    }
  }
  return {
    findings: outputs.flatMap((output) => output.findings),
    attempts: outputs.flatMap((output) => output.attempts),
    signals,
  };
}
