import type { GradeBand, Span } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { foldPlain, type SpokenLine, spokenLinesOf } from "../voice-line.ts";

/** Most words a spoken sentence should carry per band: past it, coach; past twice it, hold. */
const MAX_WORDS: Readonly<Record<GradeBand, number>> = { "K-2": 12, "3-5": 18, "6-8": 25, "9-12": 30, adult: Infinity };
/** Most clause boundaries (punctuation pauses and subordinators) one spoken sentence should stack. */
const MAX_CLAUSE_BREAKS: Readonly<Record<GradeBand, number>> = { "K-2": 2, "3-5": 3, "6-8": 4, "9-12": 5, adult: Infinity };

/** Words that open a stacked clause. "that" and "que" are left out: they are too common to count. */
const SUBORDINATOR = /\b(which|who|whom|whose|because|although|though|while|whereas|unless|whenever|wherever|if|when|since|porque|aunque|mientras|cuando|donde|quien|quienes|cual|cuales|cuyo|cuya)\b/g;
const CLAUSE_PUNCTUATION = /[,;:—–]|\s-\s/g;

/** Written math a voice reads literally ("three slash four"): a lesson spoken wrong. */
const UNVERBALIZED_MATH = /[=^×÷%√≤≥≠]|\p{N}\s*[/+*<>x-]\s*\p{N}/gu;
/** Digits and symbols a voice reads unpredictably or skips. */
const UNVERBALIZED_TEXT = /\p{N}+|[/#@&_\\|{}[\]~*<>+$€£]/gu;

const ELLIPSIS = /\.{3,}|…+/g;
/** A word in capitals: 5+ letters, or 2+ letters next to another one ("GOOD JOB"). */
const CAPS_WORD = /(?<!\p{L})\p{Lu}{2,}(?!\p{L})/gu;

/** Words too short or too common to count toward a tongue twister. */
const STOPWORDS = new Set(
  "a an the of and or to in on at for with is are was were be it its his her my your our their this that these those so but as by from not el la los las un una unos unas de del y o en con por para es son que se su sus mi tu al lo le".split(" "),
);
/** A tongue twister: this many of any window of {@link TWISTER_WINDOW} content words share an onset. */
const TWISTER_HITS = 4;
const TWISTER_WINDOW = 5;

/**
 * Flags spoken lines that are hard for young listeners to hear: sentences too long or too
 * stacked for the grade band (K-2 strictest), written math or symbols left unverbalized in the
 * spoken form, tongue-twister onsets, all-caps shouting and runs of ellipses. Runs only on
 * `voice_line.*` surfaces and reads only the spoken lines (see `spokenLinesOf`). Unverbalized
 * math and sentences over twice the band's length hold; everything else coaches.
 */
export const speakabilityEvaluator = deterministicEvaluator({
  id: "speakability",
  version: "1.0.0",
  supportedKinds: ["content.candidate", "interaction.output"],
  inspect(request) {
    const lines = spokenLinesOf(request);
    if (lines === null) return [];
    const band = request.context.gradeBand;
    const findings: FindingDraft[] = [];
    const add = (reasonCode: string, category: FindingDraft["category"], severity: FindingDraft["severity"], span?: Span) => {
      const existing = findings.find((finding) => finding.reasonCode === reasonCode);
      if (existing === undefined) findings.push({ category, reasonCode, severity, ...(span === undefined ? {} : { span }) });
      else if (severity === "hold" && existing.severity !== "hold") findings.splice(findings.indexOf(existing), 1, { ...existing, severity });
    };

    for (const line of lines) {
      const math = firstSpan(line, UNVERBALIZED_MATH);
      if (math !== null) add("speakability.unverbalized_math", "format", "hold", math);
      const symbol = firstSpan(line, UNVERBALIZED_TEXT);
      if (symbol !== null && math === null) add("speakability.unverbalized_symbols", "format", "warn", symbol);

      const caps = shoutingSpan(line);
      if (caps !== null) add("speakability.all_caps", "format", "warn", caps);
      const ellipses = line.text.match(ELLIPSIS) ?? [];
      // More than two pauses in one line, or one stretched past a single ellipsis ("....", "……").
      if (ellipses.length > 2 || ellipses.some((run) => run !== "..." && run !== "…")) {
        add("speakability.ellipsis_overuse", "format", "warn");
      }

      for (const sentence of sentencesOf(line.text)) {
        const folded = foldPlain(sentence);
        const words = folded.match(/\p{L}+(?:'\p{L}+)?/gu) ?? [];
        if (band !== undefined) {
          if (words.length > MAX_WORDS[band]) add("speakability.sentence_too_long", "age-fit", words.length > 2 * MAX_WORDS[band] ? "hold" : "warn");
          const breaks = (folded.match(CLAUSE_PUNCTUATION)?.length ?? 0) + (folded.match(SUBORDINATOR)?.length ?? 0);
          if (breaks > MAX_CLAUSE_BREAKS[band]) add("speakability.stacked_clauses", "age-fit", "warn");
        }
        if (isTongueTwister(words)) add("speakability.tongue_twister", "age-fit", "warn");
      }
    }
    return findings;
  },
});

/** Sentences of one spoken line, split after terminal punctuation; Spanish opening marks are ignored. */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\.{3,}|…/g, " ")
    .split(/[.!?]+(?:\s+|$)/)
    .map((sentence) => sentence.replace(/[¿¡]/g, "").trim())
    .filter((sentence) => /\p{L}/u.test(sentence));
}

function firstSpan(line: SpokenLine, pattern: RegExp): Span | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(line.text);
  pattern.lastIndex = 0;
  return match === null ? null : { start: line.offset + match.index, end: line.offset + match.index + match[0].length };
}

/** The first shouted word: 5+ capitals, or a capitalized word beside another. Short acronyms alone pass. */
function shoutingSpan(line: SpokenLine): Span | null {
  const words = [...line.text.matchAll(CAPS_WORD)];
  for (const [index, word] of words.entries()) {
    const next = words[index + 1];
    const adjacent = next !== undefined && /^[\s,!.?'-]*$/.test(line.text.slice(word.index + word[0].length, next.index));
    if (word[0].length >= 5 || adjacent) return { start: line.offset + word.index, end: line.offset + word.index + word[0].length };
  }
  return null;
}

/** Whether some window of content words repeats one starting consonant too often to say clearly. */
function isTongueTwister(words: readonly string[]): boolean {
  const onsets = words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)).map((word) => word[0]!);
  for (let start = 0; start + TWISTER_HITS <= onsets.length; start++) {
    const window = onsets.slice(start, start + TWISTER_WINDOW);
    const counts = new Map<string, number>();
    for (const onset of window) if (!/[aeiouy]/.test(onset)) counts.set(onset, (counts.get(onset) ?? 0) + 1);
    if ([...counts.values()].some((count) => count >= TWISTER_HITS)) return true;
  }
  return false;
}
