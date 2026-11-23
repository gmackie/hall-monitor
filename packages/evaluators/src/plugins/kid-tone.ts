import type { FindingCategory, Severity } from "@gmacko/hall-monitor-contracts";
import { isVoiceLineSurface } from "@gmacko/hall-monitor-policy";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { matchRules, type PatternRule } from "../text.ts";
import { foldPlain } from "../voice-line.ts";

/** One tone a spoken line must not take with a learner. */
export interface ToneRule {
  readonly reasonCode: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
}

const MENACING: ToneRule = { reasonCode: "tone.menacing", category: "harassment", severity: "hold" };
const SHAMING: ToneRule = { reasonCode: "tone.shaming", category: "harassment", severity: "hold" };
const SARCASM: ToneRule = { reasonCode: "tone.sarcasm", category: "harassment", severity: "warn" };
const PRESSURE: ToneRule = { reasonCode: "tone.anxiety_pressure", category: "age-fit", severity: "warn" };
const HOLLOW_PRAISE: ToneRule = { reasonCode: "tone.hollow_praise", category: "quality", severity: "warn" };

/**
 * Patterns over folded text (lowercase, diacritics removed, whitespace collapsed). Extend by
 * adding rules; each matches the tone, never a topic, so a story's villain is judged by how the
 * line speaks to the learner rather than by what it is about.
 */
export const KID_TONE_RULES: readonly PatternRule<ToneRule>[] = [
  // Menacing: a threat aimed at the learner.
  { pattern: /\b(hurry( up)?|answer|do it|try again|get it right|pay attention|listen|focus)\b[^.!?]{0,30}\bor (else|you'?ll|you will|i'?ll|i will|we'?ll)\b/, value: MENACING },
  { pattern: /\bor else\b|\byou'?ll (be sorry|regret)\b|\bdon'?t make me\b|\byou'?re (in|gonna be in) (big )?trouble\b|\bi'?m watching you\b/, value: MENACING },
  { pattern: /\b(apurate|date prisa|contesta|hazlo|presta atencion)\b[^.!?]{0,30}\bo (si no|te|vas a)\b|\bo si no\b|\bte vas a arrepentir\b|\bvas a estar en problemas\b/, value: MENACING },
  // Shaming: the learner's error or ability as a judgement of them.
  { pattern: /\bwrong again\b|\byou (should|ought to) (already )?know (this|that|better)\b|\b(even )?a (baby|toddler|little kid|kindergartner) (could|can|knows)\b|\bhow (could|can) you not\b|\bare you even (trying|listening|paying attention)\b/, value: SHAMING },
  { pattern: /\b(what'?s|what is) wrong with you\b|\bthat'?s (so )?(stupid|dumb|pathetic|embarrassing)\b|\byou'?re (so )?(stupid|dumb|hopeless|slow|lazy|bad at)\b|\byou (never|always) get (this|it|these) wrong\b|\bshame on you\b/, value: SHAMING },
  { pattern: /\b(otra vez|de nuevo) mal\b|\bdeberias saber(lo| esto| eso)\b|\bhasta un (bebe|nino pequeno) (puede|podria|sabe)\b|\bque (tonto|tonta|torpe)\b|\beres (muy )?(tonto|tonta|lento|lenta|flojo|floja)\b|\bque verguenza\b|\bni siquiera lo intentas\b/, value: SHAMING },
  // Sarcasm aimed at an attempt.
  { pattern: /\b(oh |wow,? )?(great|nice|brilliant|real smooth) (job|one|work),? (genius|einstein)\b|\bnice try\b[^.!?]{0,10}\bnot\b|\byeah,? right\b|\bwow,? (genius|einstein)\b|\boh,? (sure|great),? (another|because)\b/, value: SARCASM },
  { pattern: /\b(muy bien|bravo),? genio\b|\bsi,? claro\b|\bque listo,? eh\b/, value: SARCASM },
  // Anxiety: time pressure, stakes or fear of failing.
  { pattern: /\b(hurry( up)?|quick(ly)?|faster)\b[^.!?]{0,20}\b(answer|pick|choose|decide|solve|finish)\b|\b(time'?s|time is) (running out|almost up)\b|\bquick(ly)?,? before\b|\b(last|final) chance\b|\bdon'?t (mess|screw) (this|it) up\b|\bbetter not (fail|get it wrong|mess up)\b|\beveryone is (waiting|watching)\b|\bdon'?t (let us|let everyone) down\b/, value: PRESSURE },
  { pattern: /\b(apurate|date prisa)\b[^.!?]{0,20}\b(contesta|responde|elige|decide|resuelve|termina)\b|\bse (acaba|agota) el tiempo\b|\bultima oportunidad\b|\bno lo arruines\b|\btodos (te )?(estan )?(esperando|mirando)\b/, value: PRESSURE },
  // Hollow praise: praise for being smart rather than for the work, or praise for a wrong answer.
  { pattern: /\byou'?re (so |such a |a )?(smart|genius|natural|brilliant|born \w+)\b|\b(eres|que) (muy )?(listo|lista|inteligente|genio)\b/, value: HOLLOW_PRAISE },
  { pattern: /\b((great|good|awesome|nice) (job|work|answer)|perfect|excellent|amazing)\b[^.!?]{0,20}\b(wrong|incorrect|not (quite )?right)\b|\b(muy bien|excelente|perfecto)\b[^.!?]{0,20}\b(incorrect[oa]|esta mal)\b/, value: HOLLOW_PRAISE },
];

/** A feedback line that is nothing but a stock compliment ("Great job!", "¡Perfecto!"). */
const BARE_PRAISE = /^(?:(?:wow|yay|oh|so|really|very|super|muy|que)\s)*(?:great|good|nice|awesome|amazing|perfect|excellent|fantastic|wonderful|super|cool|bien|bravo|genial|excelente|perfecto|fantastico|increible)(?: (?:job|work|one|trabajo))?(?: (?:again|otra vez))?$/;

/**
 * Keeps spoken lines kind to young learners: menacing or shaming lines hold; sarcasm, anxiety-
 * inducing pressure and hollow praise (praise for being smart, praise on a wrong answer, or on the
 * `voice_line.feedback` surface a line that is only a stock compliment) coach. Runs only on
 * `voice_line.*` surfaces, over the whole text, since a caption is shown to the learner too.
 */
export const kidToneEvaluator = deterministicEvaluator({
  id: "kid-tone",
  version: "1.0.0",
  supportedKinds: ["content.candidate", "interaction.output"],
  inspect(request) {
    if (request.content.type !== "text" || !isVoiceLineSurface(request.source.surface)) return [];
    const folded = foldPlain(request.content.text);
    const tones = matchRules(folded, KID_TONE_RULES);
    if (request.source.surface === "voice_line.feedback" && !tones.includes(HOLLOW_PRAISE)) {
      const bare = request.content.text
        .split(/\r?\n/)
        .map((line) => foldPlain(line).replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim())
        .some((line) => line.length > 0 && BARE_PRAISE.test(line));
      if (bare) tones.push(HOLLOW_PRAISE);
    }
    const findings: FindingDraft[] = [];
    for (const tone of tones) {
      if (!findings.some((finding) => finding.reasonCode === tone.reasonCode)) {
        findings.push({ category: tone.category, reasonCode: tone.reasonCode, severity: tone.severity });
      }
    }
    return findings;
  },
});
