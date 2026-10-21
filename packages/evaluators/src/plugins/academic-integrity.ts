import { deterministicEvaluator } from "../plugin.ts";
import { foldForMatching } from "../text.ts";

const WORK = "(essay|paper|homework|assignment|worksheet|lab report|report|project|book report|test|quiz|exam|problem set)";

const DIRECT_ANSWER: readonly RegExp[] = [
  /\b(just |only )?(give|tell|send) me (all )?(the |all the )?(answers?|solutions?)\b(?! (to )?(check|compare))/,
  /\bwhat (is|are) the (correct )?answers? (to|for) (question|number|#|problem|the (test|quiz|exam|worksheet))/,
  new RegExp(`\\b(can you|could you|will you|would you|please|pls|just) (just |please )?(write|do|finish|complete|solve) (my|this|the) ${WORK}\\b`),
  new RegExp(`\\b(write|do|finish|complete|solve) (my|this|the) ${WORK} for me\\b`),
  new RegExp(`\\b(write|do|finish|complete) (it|this|that) for me\\b`),
  /\bsolve (this|it|these) for me\b/,
  /\b(without|don't|do not|no) (explaining|explanation|explain|showing (the )?work|steps)\b.{0,30}\b(answer|solution)s?\b|\b(answer|solution)s? only\b/,
  /\bdame (la|las) respuestas?\b|\bhaz (mi|la) tarea\b|\bescribe mi (ensayo|redacción|redaccion)\b/,
  /\bdonne-moi (la|les) réponses?\b|\bfais mes devoirs\b|(^| )écris ma (dissertation|rédaction)\b/,
  /\bgib mir (einfach )?die (antwort|antworten|lösung|lösungen)\b|\bmach meine hausaufgaben\b|\bschreib meinen aufsatz\b/,
  /直接(告诉|给)我答案|帮我(写|做)(作文|作业|论文)/,
];

/**
 * Detects requests to hand over answers or do the work outright. The finding is a `warn`; the
 * resolver turns it into `coach` when the policy scaffolds help or the work is graded, so a
 * learner is steered to attempt it while ordinary help ("help me write my essay", "I need to finish
 * my project") stays usable: a request matches only when it asks for the work to be done for them.
 */
export const academicIntegrityEvaluator = deterministicEvaluator({
  id: "academic-integrity",
  version: "1.0.0",
  supportedKinds: ["interaction.input"],
  inspect(request) {
    if (request.content.type !== "text") return [];
    const folded = foldForMatching(request.content.text);
    return DIRECT_ANSWER.some((pattern) => pattern.test(folded))
      ? [{ category: "academic-integrity", reasonCode: "academic_integrity.direct_answer_request", severity: "warn" }]
      : [];
  },
});
