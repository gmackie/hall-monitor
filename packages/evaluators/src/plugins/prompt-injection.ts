import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator } from "../plugin.ts";
import { foldForMatching, matchRules, type PatternRule } from "../text.ts";

type Technique = "instruction_override" | "system_prompt_exfiltration" | "role_override" | "instruction_smuggling";

const RULES: readonly PatternRule<Technique>[] = [
  {
    value: "instruction_override",
    pattern:
      /\b(ignore|disregard|forget|override|bypass|skip) (all |any |every )?(of )?(the |your |my |these |those )?(previous|prior|above|earlier|preceding|original|system|initial) (instructions?|prompts?|rules|directions|messages|guidelines|constraints)/,
  },
  { value: "instruction_override", pattern: /\b(forget|ignore) (everything|all) (you were|you've been|you have been) (told|given)/ },
  { value: "instruction_override", pattern: /ignora (todas )?las instrucciones (anteriores|previas)/ },
  { value: "instruction_override", pattern: /ignore[rz]? (toutes )?les (instructions|consignes) (précédentes|precedentes|antérieures)/ },
  { value: "instruction_override", pattern: /ignorier(e|en sie)? (alle )?(vorherigen|bisherigen|obigen) (anweisungen|instruktionen)/ },
  { value: "instruction_override", pattern: /(忽略|无视)(之前|以前|上面|先前)的?(所有)?(指令|指示|提示)/ },
  {
    value: "system_prompt_exfiltration",
    pattern:
      /\b(reveal|show|print|repeat|output|display|leak|dump|recite|tell me|give me|what (is|are|was|were)) (me )?(your|the) (full |exact |entire |original )?(system (prompt|message|instructions)|hidden (instructions|prompt|rules)|initial (instructions|prompt)|developer (message|instructions|prompt)|original instructions|instructions you were given)/,
  },
  {
    value: "role_override",
    pattern:
      /\byou are (now|no longer) (dan|an? (unfiltered|uncensored|unrestricted|jailbroken)|in (developer|god|jailbreak) mode|bound by|restricted)/,
  },
  { value: "role_override", pattern: /\b(enable|activate|enter|switch to) (developer|god|dan|jailbreak|unrestricted) mode/ },
  { value: "role_override", pattern: /\bpretend (that )?you (have no|are not bound by|don't have|do not have) (rules|restrictions|guidelines|filters|limits)/ },
  { value: "role_override", pattern: /\bact as (an? )?(unfiltered|uncensored|jailbroken|evil|unrestricted) (ai|assistant|model|chatbot)/ },
  { value: "role_override", pattern: /\bdo anything now\b/ },
  { value: "instruction_smuggling", pattern: /<\/?\s*(system|assistant|developer|tool_call|instructions?)\s*>/ },
  { value: "instruction_smuggling", pattern: /\[\[?\s*(system|inst|\/inst)\s*\]\]?/ },
  { value: "instruction_smuggling", pattern: /(^|\n|\. )\s*(system|assistant) ?: ?(you|ignore|new|override)/ },
  { value: "instruction_smuggling", pattern: /#{2,} ?(system|new instructions)/ },
  { value: "instruction_smuggling", pattern: /\b(begin|start) (system|hidden|secret) (prompt|instructions)/ },
  {
    value: "instruction_smuggling",
    pattern:
      /\b(ai|assistant|model|chatbot|language model)s?(,| reading this| that reads this)?[^.]{0,40}\b(must|should|are instructed to|will now) (ignore|forget|send|forward|email|reveal|delete|grant)/,
  },
  {
    value: "instruction_smuggling",
    pattern: /\b(send|forward|email|upload|post|exfiltrate) (all |the |every )?(student |students' |user |users' |class )?(data|records|files|conversations?|grades|passwords|emails) to\b/,
  },
];

/** Markers that the text embeds a third-party document, making any injection indirect. */
const QUOTED_DOCUMENT =
  /```|<\/?(document|doc|article|webpage|email|pdf)>|(^|\n)\s*> |\b(the following|this|here is (a|an|the)) (article|document|text|email|web ?page|page|pdf|passage|excerpt|transcript)\b|\b(summari[sz]e|translate|proofread) (this|the following)\b/;

/**
 * Heuristics for prompt injection: overriding instructions, exfiltrating the system prompt,
 * overriding the assistant's role, and smuggling instructions through markup or quoted documents.
 * Injection in a pasted document is reported as indirect. Student input is blocked; anything
 * else is held for review, since an educator may be quoting an attack they found.
 */
export const promptInjectionEvaluator = deterministicEvaluator({
  id: "prompt-injection",
  version: "1.0.0",
  supportedKinds: EvaluationKind.options,
  inspect(request) {
    if (request.content.type !== "text") return [];
    const folded = foldForMatching(request.content.text);
    const techniques = matchRules(folded, RULES);
    if (techniques.length === 0) return [];
    const indirect = QUOTED_DOCUMENT.test(request.content.text.toLowerCase());
    const severity = request.evaluationKind === "interaction.input" && request.context.audience === "student" ? "block" : "hold";
    return [
      { category: "prompt-injection", reasonCode: indirect ? "prompt_injection.indirect" : "prompt_injection.direct", severity },
      ...techniques.map((technique) => ({ category: "prompt-injection" as const, reasonCode: `prompt_injection.${technique}`, severity: "info" as const })),
    ];
  },
});
