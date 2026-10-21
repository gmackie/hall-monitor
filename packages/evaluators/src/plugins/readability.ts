import type { GradeBand } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator } from "../plugin.ts";
import { textOf } from "../text.ts";

/** The highest Flesch-Kincaid grade suited to each band; adult content has no ceiling. */
const BAND_CEILING: Readonly<Record<GradeBand, number>> = { "K-2": 3, "3-5": 6, "6-8": 9, "9-12": 13, adult: Infinity };
/** Grades of slack above the ceiling: the formula is noisy on short or technical text. */
const SLACK = 2;
/** Below this many words the formula is too noisy to report. */
const MIN_WORDS = 30;

/**
 * Flesch-Kincaid grade level of English text:
 * `0.39 × words/sentences + 11.8 × syllables/words − 15.59`, with a vowel-group syllable
 * heuristic. Returns null when the text is too short or not mostly Latin script.
 */
export function fleschKincaidGrade(text: string): number | null {
  const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latinLetters = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (words.length < MIN_WORDS || latinLetters < letters * 0.9) return null;
  const sentences = Math.max(1, text.split(/[.!?]+(?:\s|$)/).filter((part) => /[A-Za-z]/.test(part)).length);
  const syllables = words.reduce((sum, word) => sum + syllableCount(word), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

function syllableCount(word: string): number {
  const lower = word.toLowerCase();
  const groups = lower.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = lower.length > 2 && lower.endsWith("e") && !/[aeiouy]le$/.test(lower) ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/**
 * Flags candidate content whose reading level is well above its grade band, so it can be revised
 * before it reaches learners. Advisory (`warn` → coach), English only.
 */
export const readabilityEvaluator = deterministicEvaluator({
  id: "readability",
  version: "1.0.0",
  supportedKinds: ["content.candidate"],
  inspect(request) {
    const band = request.context.gradeBand;
    const text = textOf(request);
    if (text === null || band === undefined) return [];
    const grade = fleschKincaidGrade(text);
    return grade !== null && grade > BAND_CEILING[band] + SLACK
      ? [{ category: "age-fit", reasonCode: "age_fit.readability_above_band", severity: "warn" }]
      : [];
  },
});
