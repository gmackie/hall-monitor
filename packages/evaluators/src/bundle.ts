import type { EvaluatorBundle } from "./plugin.ts";
import { academicIntegrityEvaluator } from "./plugins/academic-integrity.ts";
import { answerLeakageEvaluator } from "./plugins/answer-leakage.ts";
import { characterVoiceEvaluator } from "./plugins/character-voice.ts";
import { boundsEvaluator } from "./plugins/bounds.ts";
import { harmfulContentEvaluator } from "./plugins/harmful-content.ts";
import { kidToneEvaluator } from "./plugins/kid-tone.ts";
import { piiEvaluator } from "./plugins/pii.ts";
import { promptInjectionEvaluator } from "./plugins/prompt-injection.ts";
import { readabilityEvaluator } from "./plugins/readability.ts";
import { selfHarmEvaluator } from "./plugins/self-harm.ts";
import { speakabilityEvaluator } from "./plugins/speakability.ts";
import { spokenAnswerLeakageEvaluator } from "./plugins/spoken-answer-leakage.ts";

/**
 * Revision of the default bundle. Bump it whenever any plugin's version changes, so results can
 * be traced to the exact evaluators that produced them.
 */
export const EVALUATOR_BUNDLE_REVISION = "base-1.2.0";

/**
 * The deterministic base bundle: no provider calls, no cost, same input gives the same findings.
 * The voice-line evaluators (speakability, spoken answer leakage, kid tone, and character-voice
 * consistency when the request carries `context.speakerProfile`) run only on `voice_line.*`
 * surfaces and return nothing elsewhere.
 */
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
    speakabilityEvaluator,
    spokenAnswerLeakageEvaluator,
    kidToneEvaluator,
    characterVoiceEvaluator,
  ]),
});
