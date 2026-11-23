import type { FindingCategory, Severity, Span, SpeakerProfile } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { foldPlain, type SpokenLine, spokenLinesOf } from "../voice-line.ts";

/**
 * Slang, over folded text (lowercase, diacritics removed). English and basic Spanish; extend by
 * adding alternatives. Words a formal or neutral speaker would not say aloud.
 */
export const SLANG =
  /\b(gonna|wanna|gotta|kinda|sorta|dunno|lemme|gimme|ain'?t|y'?all|dude|bro|bruh|lol|omg|lmao|totes|yep|yup|nope|nah|yeah|cool beans|no cap|epic fail|awesome sauce|whatevs|chido|chida|guay|mola|molon|porfa|bacan[oa]|chever[ea]|que onda|wey|guey|neta|chamba)\b/g;

/** Contractions ("don't", "we're", "let's"). Counted against the words of a formal speaker's line. */
const CONTRACTION = /\b\p{L}+'(t|re|ll|ve|m|d|s)\b/gu;

/** Phrasing too stiff for a playful speaker: these markers, two or more in a chunk. */
const VERY_FORMAL =
  /\b(furthermore|moreover|therefore|thus|hence|consequently|nevertheless|accordingly|henceforth|whereby|aforementioned|shall|kindly|one must|it is imperative|in accordance with|por consiguiente|asimismo|no obstante|por lo tanto|cabe destacar|en consecuencia|de conformidad con)\b/g;

/** Sarcasm aimed at an attempt (shares kid-tone's markers, plus a few milder ones). */
const SARCASM =
  /\b(oh |wow,? )?(great|nice|brilliant|real smooth) (job|one|work),? (genius|einstein)\b|\bnice try\b[^.!?]{0,10}\b(not|but no)\b|\byeah,? right\b|\bwow,? (genius|einstein)\b|\boh,? (sure|great),? (another|because|that)\b|\bwhat a (surprise|shocker)\b|\bbig surprise\b|\bthanks a lot\b|\breal (smart|clever)\b|\bhow (clever|original)\b|\bas if\b|\b(muy bien|bravo),? genio\b|\bsi,? claro\b|\bque listo,? eh\b|\bque sorpresa\b/;

/** Teasing aimed at the learner. */
const TEASING =
  /\bha ?ha\b[^.!?]{0,15}\b(you|wrong|nope|missed)\b|\btoo slow\b|\bslowpoke\b|\bneener\b|\bnanny,? nanny\b|\bna na na\b|\btold you so\b|\bloser\b|\bja ?ja\b[^.!?]{0,15}\b(no|te equivocaste|fallaste)\b|\blero,? lero\b|\bte lo dije\b|\bperdedor[a]?\b/;

/** First-person pronouns a narrator should not use outside quoted dialogue. */
const FIRST_PERSON = /\b(i|i'm|i've|i'll|i'd|me|my|mine|myself|yo|conmigo|mi|mis)\b/g;
/** Quoted dialogue, which a narrator may voice in any person. */
const QUOTED = /"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’/g;

const EXCLAMATION_RUN = /!{2,}|¡{2,}/g;
/** A word in capitals: 4+ letters, or two capitalized words side by side. */
const CAPS_WORD = /(?<!\p{L})\p{Lu}{2,}(?!\p{L})/gu;

interface Rule {
  readonly reasonCode: string;
  readonly category: FindingCategory;
}

const REGISTER: Rule = { reasonCode: "character_voice.register_mismatch", category: "quality" };
const FORBIDDEN_SLANG: Rule = { reasonCode: "character_voice.forbidden_slang", category: "quality" };
const FORBIDDEN_SARCASM: Rule = { reasonCode: "character_voice.forbidden_sarcasm", category: "quality" };
const FORBIDDEN_EXCLAMATION: Rule = { reasonCode: "character_voice.forbidden_exclamation_spam", category: "quality" };
const FORBIDDEN_CAPS: Rule = { reasonCode: "character_voice.forbidden_all_caps", category: "quality" };
const ROLE_SARCASM: Rule = { reasonCode: "character_voice.role_sarcasm", category: "harassment" };
const NARRATOR_FIRST_PERSON: Rule = { reasonCode: "character_voice.narrator_first_person", category: "quality" };
const CATCHPHRASE_OVERUSE: Rule = { reasonCode: "character_voice.catchphrase_overuse", category: "quality" };

/** Contraction share of a formal speaker's words past which the line reads as casual. */
const FORMAL_CONTRACTION_SHARE = 0.12;
/** Most times one catchphrase may appear in one chunk. */
const MAX_CATCHPHRASE_USES = 2;

/**
 * Checks spoken lines against `context.speakerProfile`, the authored persona of who speaks them:
 *
 * - **register**: slang, dense contractions or heavy exclamation for a `formal` speaker (slang or
 *   two slang words or heavy exclamation for `neutral`); two or more very formal markers for a `playful` one.
 * - **forbids**: `slang`, `sarcasm`, `exclamation_spam` and `all_caps`; unknown codes are ignored.
 * - **role**: a teacher, coach or narrator never teases or is sarcastic (held for teacher and
 *   coach, coached for the narrator); a narrator speaks in the third person, so first-person
 *   pronouns outside quoted dialogue coach.
 * - **catchphrases**: one used more than twice in a chunk coaches.
 *
 * Runs only on `voice_line.*` surfaces with a speaker profile, over the spoken lines. Without a
 * profile it returns nothing. Findings carry codes and spans only, never the profile or the text.
 */
export const characterVoiceEvaluator = deterministicEvaluator({
  id: "character-voice-consistency",
  version: "1.0.0",
  supportedKinds: ["content.candidate", "interaction.output"],
  inspect(request) {
    const speaker = request.context.speakerProfile;
    if (speaker === undefined) return [];
    const lines = spokenLinesOf(request);
    if (lines === null || lines.length === 0) return [];
    return inspectSpeaker(speaker, lines);
  },
});

/** The findings for `lines` spoken by `speaker`. Exported for tests and tools. */
export function inspectSpeaker(speaker: SpeakerProfile, lines: readonly SpokenLine[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const add = (rule: Rule, severity: Severity, span?: Span) => {
    if (findings.some((finding) => finding.reasonCode === rule.reasonCode)) return;
    findings.push({ category: rule.category, reasonCode: rule.reasonCode, severity, ...(span === undefined ? {} : { span }) });
  };

  const folded = lines.map((line) => foldPlain(line.text));
  const all = folded.join(" ");
  const words = all.match(/\p{L}+(?:'\p{L}+)?/gu) ?? [];
  const slang = count(all, SLANG);
  const exclamationRun = firstSpan(lines, EXCLAMATION_RUN);
  /** A run of exclamation marks, or more than two in one spoken line. */
  const heavyExclamation = exclamationRun !== null || lines.some((line) => exclamations(line.text) > 2);
  const sarcastic = SARCASM.test(all) || TEASING.test(all);
  const forbids = new Set(speaker.forbids ?? []);

  // Register.
  switch (speaker.register) {
    case "formal": {
      const contractions = count(all, CONTRACTION);
      const dense = contractions >= 2 && contractions / Math.max(words.length, 1) > FORMAL_CONTRACTION_SHARE;
      const exclaims = heavyExclamation || lines.some((line) => exclamations(line.text) > 1);
      if (slang > 0 || dense || exclaims) add(REGISTER, "warn");
      break;
    }
    case "neutral":
      if (slang >= 2 || heavyExclamation) add(REGISTER, "warn");
      break;
    case "playful":
      if (count(all, VERY_FORMAL) >= 2) add(REGISTER, "warn");
      break;
    case "casual":
    case undefined:
      break;
  }

  // Forbidden patterns.
  if (forbids.has("slang") && slang > 0) add(FORBIDDEN_SLANG, "warn");
  if (forbids.has("sarcasm") && sarcastic) add(FORBIDDEN_SARCASM, "warn");
  if (forbids.has("exclamation_spam") && heavyExclamation) {
    add(FORBIDDEN_EXCLAMATION, "warn", exclamationRun ?? undefined);
  }
  if (forbids.has("all_caps")) {
    const caps = capsSpan(lines);
    if (caps !== null) add(FORBIDDEN_CAPS, "warn", caps);
  }

  // Role rules.
  if (speaker.role !== "character" && sarcastic) {
    add(ROLE_SARCASM, speaker.role === "narrator" ? "warn" : "hold");
  }
  if (speaker.role === "narrator") {
    const narration = lines.map((line) => foldPlain(line.text.replace(QUOTED, " "))).join(" ");
    const narrationWords = narration.match(/\p{L}+(?:'\p{L}+)?/gu)?.length ?? 0;
    const firstPerson = count(narration, FIRST_PERSON);
    if (firstPerson >= 2 && firstPerson / Math.max(narrationWords, 1) >= 0.04) add(NARRATOR_FIRST_PERSON, "warn");
  }

  // Catchphrases.
  const plain = ` ${wordsOnly(all)} `;
  for (const phrase of speaker.catchphrases ?? []) {
    const needle = wordsOnly(foldPlain(phrase));
    if (needle.length === 0) continue;
    let uses = 0;
    for (let at = plain.indexOf(` ${needle} `); at !== -1; at = plain.indexOf(` ${needle} `, at + needle.length + 1)) uses++;
    if (uses > MAX_CATCHPHRASE_USES) {
      add(CATCHPHRASE_OVERUSE, "warn");
      break;
    }
  }
  return findings;
}

function exclamations(text: string): number {
  return text.match(/!/g)?.length ?? 0;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Letters and digits only, single-spaced, so "Ahoy, matey!" and "ahoy matey" compare equal. */
function wordsOnly(text: string): string {
  return text.replace(/[^\p{L}\p{N}']+/gu, " ").replace(/\s+/g, " ").trim();
}

function firstSpan(lines: readonly SpokenLine[], pattern: RegExp): Span | null {
  for (const line of lines) {
    pattern.lastIndex = 0;
    const match = pattern.exec(line.text);
    pattern.lastIndex = 0;
    if (match !== null) return { start: line.offset + match.index, end: line.offset + match.index + match[0].length };
  }
  return null;
}

/** The first capitalized word of 4+ letters, or of 2+ letters beside another one. */
function capsSpan(lines: readonly SpokenLine[]): Span | null {
  for (const line of lines) {
    const words = [...line.text.matchAll(CAPS_WORD)];
    for (const [index, word] of words.entries()) {
      const next = words[index + 1];
      const adjacent = next !== undefined && /^[\s,!.?'-]*$/.test(line.text.slice(word.index + word[0].length, next.index));
      if (word[0].length >= 4 || adjacent) return { start: line.offset + word.index, end: line.offset + word.index + word[0].length };
    }
  }
  return null;
}
