import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { foldForMatching } from "../text.ts";

/** Answers shorter than this are too ambiguous ("B", "4") to look for verbatim. */
const MIN_ANSWER_LENGTH = 3;

const ANSWER_KEY_MARKER = /\b(answer key|answer sheet|solutions? manual)\b|(^|\n)\s*answers?\s*:\s*(\n\s*)?(1|a)[.)]/i;

/**
 * Detects answers leaking into student-facing candidate content or model output: any entry of the
 * request's `answerKey` appearing as a whole phrase (held), or an answer-key section in content
 * meant for students (held; noted for other audiences).
 */
export const answerLeakageEvaluator = deterministicEvaluator({
  id: "answer-leakage",
  version: "1.0.0",
  supportedKinds: ["content.candidate", "interaction.output"],
  inspect(request) {
    if (request.content.type !== "text") return [];
    const folded = ` ${foldForMatching(request.content.text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    const findings: FindingDraft[] = [];
    const leaked = (request.content.answerKey ?? [])
      .map((answer) => foldForMatching(answer).replace(/[^\p{L}\p{N}]+/gu, " ").trim())
      .some((answer) => answer.length >= MIN_ANSWER_LENGTH && folded.includes(` ${answer} `));
    if (leaked) findings.push({ category: "academic-integrity", reasonCode: "academic_integrity.answer_leakage", severity: "hold" });
    if (ANSWER_KEY_MARKER.test(request.content.text)) {
      findings.push({
        category: "academic-integrity",
        reasonCode: "academic_integrity.answer_key_marker",
        severity: request.context.audience === "student" ? "hold" : "info",
      });
    }
    return findings;
  },
});
