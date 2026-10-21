import { EvaluationKind, type FindingCategory, type Severity } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { ACADEMIC_FRAMING, foldForMatching, matchRules, type PatternRule } from "../text.ts";

interface Harm {
  readonly category: FindingCategory;
  readonly reasonCode: string;
  /** Severity when the framing is academic; instructions for harm stay blocked regardless. */
  readonly framed: Severity;
  readonly unframed: Severity;
}

const instructions = (reasonCode: string): Harm => ({ category: "safety", reasonCode, framed: "block", unframed: "block" });

const WEAPONS = instructions("safety.weapon_instructions");
const DRUGS = instructions("safety.drug_synthesis");
const POISON = instructions("safety.poison_instructions");
const CREDENTIALS = instructions("safety.credential_theft");
const FILTER_BYPASS: Harm = { category: "safety", reasonCode: "safety.filter_bypass", framed: "hold", unframed: "block" };
const THREAT: Harm = { category: "violence", reasonCode: "violence.threat", framed: "block", unframed: "block" };
const INCITEMENT: Harm = { category: "harassment", reasonCode: "harassment.self_harm_incitement", framed: "block", unframed: "block" };
const INSULT: Harm = { category: "harassment", reasonCode: "harassment.insult", framed: "info", unframed: "warn" };
const EXCLUSION: Harm = { category: "harassment", reasonCode: "harassment.exclusion", framed: "info", unframed: "hold" };
const DEHUMANIZATION: Harm = { category: "hate", reasonCode: "hate.dehumanization", framed: "hold", unframed: "block" };
const SEXUAL_SOLICITATION: Harm = { category: "sexual", reasonCode: "sexual.solicitation", framed: "block", unframed: "block" };

const LEAD =
  "(how (do|can|could|would|should) (i|you|we|someone|one|a person)|how to|steps to|step by step|instructions (for|to|on)|guide to|teach me( how)? to|tell me how to|show me how to|recipe for|walk me through how to)";
const MAKE = "(make|build|assemble|create|construct|3d print|print|manufacture|cook|synthesi[sz]e|brew|mix|produce|get)";
const SOME = "( a| an| my own| our own| some| homemade)?";
const make = (targets: string) => new RegExp(`\\b${LEAD} ${MAKE}${SOME} (${targets})\\b`);

const RULES: readonly PatternRule<Harm>[] = [
  { value: WEAPONS, pattern: make("bombs?|pipe bombs?|explosives?|ieds?|molotov( cocktails?)?|grenades?|napalm|ghost guns?|untraceable guns?|guns?|firearms?|silencers?|suppressors?") },
  { value: WEAPONS, pattern: /c[oó]mo (hacer|fabricar|construir) (una )?(bomba|explosivo)/ },
  { value: WEAPONS, pattern: /comment (fabriquer|faire|construire) (une )?(bombe|explosif)/ },
  { value: WEAPONS, pattern: /wie (baue|mache|bastle) ich (eine )?(bombe|sprengstoff)/ },
  { value: WEAPONS, pattern: /(怎么|如何)(做|制作|制造|造)炸弹/ },
  { value: DRUGS, pattern: make("meth|methamphetamine|crystal meth|fentanyl|heroin|crack|lsd|mdma") },
  { value: POISON, pattern: make("ricin|sarin|nerve agents?|poisons?|toxic gas|chlorine gas") },
  { value: POISON, pattern: /\b(poison|drug) (my|a|the|his|her|their|someone's) (teacher|classmate|friend|sister|brother|mom|dad|parent|drink|food)\b/ },
  {
    value: CREDENTIALS,
    pattern:
      /\b(steal|phish|crack|hack|break into)( a| the| someone's| somebody's| his| her| their| my (teacher|classmate|friend|mom|dad|sister|brother|principal)'s)? (password|passwords|login|credentials|account|email|gradebook)\b/,
  },
  { value: CREDENTIALS, pattern: /\bhack (into )?(the |my |our )?(school'?s?|teacher'?s|district'?s|someone'?s) (system|network|account|email|gradebook|grades|portal|database|wifi)/ },
  { value: CREDENTIALS, pattern: /\b(keylogger|phishing (page|site|email|link|kit)|credential (harvester|stealer)|password stealer)\b/ },
  { value: CREDENTIALS, pattern: /\b(change|edit|fix) my grades? (in|on) (the )?(gradebook|portal|system)\b/ },
  { value: FILTER_BYPASS, pattern: /\b(bypass|get around|get past|disable|turn off|evade) (the |my )?(school'?s? )?(web |content |internet )?(filter|firewall|blocker|monitoring|safety settings)\b/ },
  {
    value: THREAT,
    pattern:
      /\bi('m| am|'ll| will| want to| wanna| am going to|'m going to|'m gonna| am gonna) (kill|shoot|stab|hurt|beat up|attack|bomb) (him|her|them|you|everyone|everybody|my (teacher|classmate|classmates|brother|sister|mom|dad|principal)|the (school|class|teacher|principal))\b/,
  },
  { value: THREAT, pattern: /\b(bring|take) (a )?(gun|knife|weapon|bomb) to school\b/ },
  { value: INCITEMENT, pattern: /\b(go )?(kill|hang) yourself\b|\bkys\b|\byou should (just )?die\b/ },
  {
    value: INSULT,
    pattern: /\byou('re| are)( so| such an?| a| an| really)? (stupid|idiot|dumb|worthless|ugly|loser|pathetic|useless|disgusting|fat)\b/,
  },
  { value: INSULT, pattern: /\b(nobody|no one) (likes|loves|wants|cares about) you\b/ },
  { value: EXCLUSION, pattern: /\b(help me|let's|we should) (make|get) (everyone|the whole class|people) (to )?(hate|ignore|exclude|bully|laugh at) (him|her|them)\b/ },
  {
    value: DEHUMANIZATION,
    pattern: /\b(all|those|these|every) [a-z]+( people)? (should|must|deserve to|need to) (all )?(die|be (killed|exterminated|wiped out|eliminated|gassed))\b|\b(are|is) (subhuman|vermin|animals|cockroaches)\b/,
  },
  { value: SEXUAL_SOLICITATION, pattern: /\b(send|show) (me )?(your )?(nudes|nude (pics|photos)|naked (pics|photos|pictures))\b|\bsext(ing)? (me|with me)\b/ },
];

/** Topics that are sensitive but routinely studied; flagged only for context, never blocked. */
const SENSITIVE_TOPIC =
  /\b(war|wars|wwii|ww2|world war|genocide|holocaust|slavery|violence|violent|murder|killings?|death|deaths|suicide|war crimes|bombs?|bombing|atomic|weapons?|drugs?|overdose|addiction|abuse|terrorism|massacre|battle|lynching|segregation|assassination)\b|guerra|guerre|krieg|战争/;

/**
 * Lexicon of harmful *intent*: instructions for weapons, drugs and poisons, credential theft,
 * filter bypass, threats, harassment, dehumanizing hate and sexual solicitation.
 *
 * Framing changes some outcomes but not instructions for harm: "why did WWII start" or "themes of
 * violence in Macbeth" produce only an informational sensitive-topic note, while "for my
 * chemistry essay, how do I make a pipe bomb" is still blocked. Hate rhetoric under academic
 * framing (quoting propaganda in a history essay) is held for review instead of blocked.
 */
export const harmfulContentEvaluator = deterministicEvaluator({
  id: "harmful-content",
  version: "1.0.0",
  supportedKinds: EvaluationKind.options,
  inspect(request) {
    if (request.content.type !== "text") return [];
    const folded = foldForMatching(request.content.text);
    const framed = ACADEMIC_FRAMING.test(folded);
    const findings: FindingDraft[] = matchRules(folded, RULES).map((harm) => ({
      category: harm.category,
      reasonCode: harm.reasonCode,
      severity: framed ? harm.framed : harm.unframed,
    }));
    if (findings.length === 0 && framed && SENSITIVE_TOPIC.test(folded)) {
      findings.push({ category: "safety", reasonCode: "sensitive_topic.academic_context", severity: "info" });
    }
    return findings;
  },
});
