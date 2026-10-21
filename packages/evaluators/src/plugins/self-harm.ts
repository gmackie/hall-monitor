import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator } from "../plugin.ts";
import { foldForMatching } from "../text.ts";

/**
 * First-person distress phrases. Third-person and literary phrasing ("why does Hamlet want to
 * die") does not match; hyperbole such as "I want to die, this test is so hard" deliberately does,
 * because a supportive check-in costs little and missing a real disclosure costs a great deal.
 */
const DISTRESS: readonly RegExp[] = [
  /\bi (really |just |kind of |sometimes |honestly )?(want|wanna|wish i could|need) (to )?(die|kill myself|end my life|end it all|disappear forever|not wake up|stop existing)\b/,
  /\bi('m| am|'ve been| have been) (going|planning|thinking about|thinking of) (to )?(kill(ing)? myself|end(ing)? my life|end(ing)? it all|suicide|hurt(ing)? myself)\b/,
  /\bi keep thinking about (suicide|killing myself|ending it|dying|hurting myself)\b/,
  /\bi('ve| have)? (been )?(cut|cutting|hurt|hurting|harm|harming|burn|burning) myself\b/,
  /\b(there's |there is )?(no|not any|no more) (reason|point) (to|in) (live|living|going on|being alive)\b/,
  /\b(nobody|no one) would (care|miss me|notice|even notice) if i (died|was gone|were gone|disappeared|killed myself)\b/,
  /\bi don't want to (be alive|live|live anymore|exist|exist anymore|be here anymore|wake up)\b/,
  /\b(everyone|they|my family) would be better off without me\b/,
  /\bi('m| am) (suicidal|thinking about suicide)\b/,
  /quiero (morir|morirme|matarme|desaparecer para siempre)|no quiero (vivir|seguir viviendo)|me quiero matar/,
  /je (veux|voudrais) (mourir|me tuer|en finir)|j'ai envie de mourir|je ne veux plus vivre/,
  /ich (will|möchte|moechte) (sterben|mich umbringen|nicht mehr leben)|ich will mir das leben nehmen/,
  /我想死|不想活|想自杀|活着没有意义/,
];

/**
 * Detects personal distress and self-harm disclosures and routes them to `support`: the
 * supportive safety path, never a block or a disciplinary signal. Only model output and user
 * input are checked; content about suicide as a topic is left to the classifier.
 */
export const selfHarmEvaluator = deterministicEvaluator({
  id: "self-harm",
  version: "1.0.0",
  supportedKinds: EvaluationKind.options.filter((kind) => kind !== "assessment.evaluator-result"),
  inspect(request) {
    if (request.content.type !== "text") return [];
    const folded = foldForMatching(request.content.text);
    return DISTRESS.some((pattern) => pattern.test(folded))
      ? [{ category: "self-harm", reasonCode: "self_harm.disclosure", severity: "support" }]
      : [];
  },
});
