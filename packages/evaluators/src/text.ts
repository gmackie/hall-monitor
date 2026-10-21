import type { EvaluationRequest, Span } from "@gmacko/hall-monitor-contracts";

/** The request's text, or null when only a digest was supplied. */
export function textOf(request: EvaluationRequest): string | null {
  return request.content.type === "text" ? request.content.text : null;
}

const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * A matching form of `text`: compatibility-normalized, lowercased, with invisible characters
 * removed and whitespace collapsed, so obfuscation such as zero-width joins or full-width letters
 * does not evade a pattern. Offsets into it do not map back to the original text.
 */
export function foldForMatching(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\s+/g, " ");
}

/** A rule matched against folded text. */
export interface PatternRule<T> {
  readonly pattern: RegExp;
  readonly value: T;
}

/** The values of every rule whose pattern matches `folded`, without duplicates, in rule order. */
export function matchRules<T>(folded: string, rules: readonly PatternRule<T>[]): T[] {
  const matched: T[] = [];
  for (const rule of rules) if (rule.pattern.test(folded) && !matched.includes(rule.value)) matched.push(rule.value);
  return matched;
}

/** Every match of a global pattern in `text`, as spans into it. */
export function spansOf(text: string, pattern: RegExp, accept: (match: string) => boolean = () => true): Span[] {
  if (!pattern.global) throw new TypeError("spansOf needs a global pattern");
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined && accept(match[0])) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Framing that marks a sensitive topic as study rather than intent: historical, literary,
 * analytical and health-education questions.
 */
export const ACADEMIC_FRAMING =
  /\b(why (did|does|do|was|were|is|are)|what (caused|causes|led to|were the (causes|effects|consequences))|causes of|effects of|history of|historical|historians?|themes? of|symbolism|in the (novel|play|poem|story|book|film|chapter)|the (author|narrator|poet|character)|analy[sz]e|analysis|essay (about|on)|discuss|compare|explain (why|how|the)|according to|during (the|world war)|what (is|are) the (signs|symptoms|risks)|health class|warning signs|(history|english|literature|health|biology|chemistry|civics|social studies) (class|essay|project|report|homework)|macbeth|hamlet|romeo and juliet|the odyssey|the iliad|of mice and men|to kill a mockingbird|lord of the flies|the crucible|night by elie wiesel|anne frank)\b|¿por qué|pourquoi|warum|为什么/;
