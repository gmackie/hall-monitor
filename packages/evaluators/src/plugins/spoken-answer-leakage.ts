import { deterministicEvaluator } from "../plugin.ts";
import { canonicalSpokenForm } from "../spoken-numbers.ts";
import { foldForMatching } from "../text.ts";
import { spokenLinesOf } from "../voice-line.ts";

/** Answers shorter than this as written ("B", "4", "12") are too ambiguous to look for, as in answer-leakage. */
const MIN_ANSWER_LENGTH = 3;

/**
 * Answer leakage for spoken lines: the request's `answerKey` (the same field answer-leakage
 * reads) is matched against what the voice says, after both are put in canonical number form, so
 * "three fourths" leaks the answer "3/4" and "twenty-one" leaks "21 apples". Runs only on
 * `voice_line.*` surfaces and reads only the spoken lines; a leak in the caption is
 * answer-leakage's to report. Holds, like a written leak.
 */
export const spokenAnswerLeakageEvaluator = deterministicEvaluator({
  id: "spoken-answer-leakage",
  version: "1.0.0",
  supportedKinds: ["content.candidate", "interaction.output"],
  inspect(request) {
    if (request.content.type !== "text" || request.content.answerKey === undefined) return [];
    const lines = spokenLinesOf(request);
    if (lines === null || lines.length === 0) return [];
    const spoken = ` ${lines.map((line) => canonicalSpokenForm(line.text)).join(" | ")} `;
    const leaked = request.content.answerKey
      .filter((answer) => foldForMatching(answer).replace(/[^\p{L}\p{N}]+/gu, "").length >= MIN_ANSWER_LENGTH || /\p{N}\s*\/\s*\p{N}/u.test(answer))
      .map(canonicalSpokenForm)
      .some((answer) => answer.length > 0 && spoken.includes(` ${answer} `));
    return leaked ? [{ category: "academic-integrity", reasonCode: "academic_integrity.spoken_answer_leakage", severity: "hold" }] : [];
  },
});
