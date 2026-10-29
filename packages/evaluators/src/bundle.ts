import type { EvaluatorBundle } from "./plugin.ts";
import { academicIntegrityEvaluator } from "./plugins/academic-integrity.ts";
import { answerLeakageEvaluator } from "./plugins/answer-leakage.ts";
import { boundsEvaluator } from "./plugins/bounds.ts";
import { harmfulContentEvaluator } from "./plugins/harmful-content.ts";
import { piiEvaluator } from "./plugins/pii.ts";
import { promptInjectionEvaluator } from "./plugins/prompt-injection.ts";
import { readabilityEvaluator } from "./plugins/readability.ts";
import { selfHarmEvaluator } from "./plugins/self-harm.ts";

/**
 * Revision of the default bundle. Bump it whenever any plugin's version changes, so results can
 * be traced to the exact evaluators that produced them.
 */
export const EVALUATOR_BUNDLE_REVISION = "base-1.0.1";

/** The deterministic base bundle: no provider calls, no cost, same input gives the same findings. */
export const defaultBundle: EvaluatorBundle = Object.freeze({
  id: "hall-monitor-base",
  revision: EVALUATOR_BUNDLE_REVISION,
  plugins: Object.freeze([
    boundsEvaluator,
    piiEvaluator,
    promptInjectionEvaluator,
    harmfulContentEvaluator,
    selfHarmEvaluator,
    academicIntegrityEvaluator,
    readabilityEvaluator,
    answerLeakageEvaluator,
  ]),
});
