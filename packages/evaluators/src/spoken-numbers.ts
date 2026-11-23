import { foldPlain } from "./voice-line.ts";

/**
 * A small English and Spanish number-word normalizer for matching spoken text against written
 * answers. Both sides are reduced to the same canonical tokens, so "three fourths", "three
 * quarters", "3 / 4" and "tres cuartos" all become `3/4`, "twenty-one" becomes `21`, "two point
 * five" becomes `2.5` and "fifty percent" becomes `50%`. It is deliberately small: whole numbers
 * below a billion, simple fractions, decimals read digit by digit, percentages and "negative".
 * It does not equate different values (`3/4` is not `0.75`).
 */

type WordKind = "unit" | "teen" | "tens" | "hundreds";

const WORDS: ReadonlyMap<string, readonly [WordKind, number]> = new Map<string, readonly [WordKind, number]>([
  // English.
  ...(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].map((w, i) => [w, ["unit", i]] as const)),
  ...(["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].map((w, i) => [w, ["teen", 10 + i]] as const)),
  ...(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((w, i) => [w, ["tens", 20 + 10 * i]] as const)),
  // Spanish (diacritics folded away).
  ...(["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"].map((w, i) => [w, ["unit", i]] as const)),
  ["un", ["unit", 1]],
  ["una", ["unit", 1]],
  // Spanish "once" (11) is left out: it is also the English word.
  ["diez", ["teen", 10]],
  ...(["doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte"].map((w, i) => [w, ["teen", 12 + i]] as const)),
  ...(["veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"].map((w, i) => [w, ["teen", 21 + i]] as const)),
  ["veintiun", ["teen", 21]],
  ["veintiuna", ["teen", 21]],
  ...(["treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"].map((w, i) => [w, ["tens", 30 + 10 * i]] as const)),
  ["cien", ["hundreds", 100]],
  ["ciento", ["hundreds", 100]],
  ...(["doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"].flatMap((w, i) => [
    [w, ["hundreds", 200 + 100 * i]] as const,
    [w.replace(/os$/, "as"), ["hundreds", 200 + 100 * i]] as const,
  ])),
]);

const SCALES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1_000],
  ["mil", 1_000],
  ["million", 1_000_000],
  ["millon", 1_000_000],
  ["millones", 1_000_000],
]);

/** Fraction denominators read as words: "fourths", "quarter", "tercio", "cuartos". */
const DENOMINATORS: ReadonlyMap<string, number> = new Map([
  ["half", 2], ["halves", 2], ["third", 3], ["thirds", 3], ["fourth", 4], ["fourths", 4], ["quarter", 4], ["quarters", 4],
  ["fifth", 5], ["fifths", 5], ["sixth", 6], ["sixths", 6], ["seventh", 7], ["sevenths", 7], ["eighth", 8], ["eighths", 8],
  ["ninth", 9], ["ninths", 9], ["tenth", 10], ["tenths", 10], ["hundredth", 100], ["hundredths", 100],
  ["medio", 2], ["medios", 2], ["tercio", 3], ["tercios", 3], ["cuarto", 4], ["cuartos", 4], ["quinto", 5], ["quintos", 5],
  ["sexto", 6], ["sextos", 6], ["septimo", 7], ["septimos", 7], ["octavo", 8], ["octavos", 8], ["noveno", 9], ["novenos", 9],
  ["decimo", 10], ["decimos", 10], ["centesimo", 100], ["centesimos", 100],
]);

/** Words that read a fraction bar ("three over four") or a decimal point. */
const OVER = new Set(["/", "over", "sobre"]);
const POINT = new Set(["point", "punto", "coma"]);
const PERCENT = new Set(["%", "percent", "percentage"]);
/** Articles that mean one only before a denominator: "a half", "an eighth". */
const ONE_BEFORE_DENOMINATOR = new Set(["a", "an"]);

const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+|[/%]/gu;

/** The canonical tokens of `text`: folded words, with numbers, fractions, decimals and percentages written in digits. */
export function canonicalTokens(text: string): string[] {
  const raw = (foldPlain(text).match(TOKEN) ?? []).map((token) => (/^\p{N}{1,3}(,\p{N}{3})+$/u.test(token) ? token.replace(/,/g, "") : token));
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const token = raw[i]!;
    if (token === "negative" && numberAt(raw, i + 1) !== null) {
      const parsed = readNumber(raw, i + 1);
      out.push(`-${parsed.value}`);
      i = parsed.next;
      continue;
    }
    if (ONE_BEFORE_DENOMINATOR.has(token) && DENOMINATORS.has(raw[i + 1] ?? "")) {
      out.push(`1/${DENOMINATORS.get(raw[i + 1]!)}`);
      i += 2;
      continue;
    }
    if (numberAt(raw, i) === null) {
      out.push(token);
      i++;
      continue;
    }
    const parsed = readNumber(raw, i);
    out.push(parsed.value);
    i = parsed.next;
  }
  return out;
}

/** `text` in canonical form, one space between tokens. */
export function canonicalSpokenForm(text: string): string {
  return canonicalTokens(text).join(" ");
}

/** A whole number starting at `i`, in digits or words, or null. */
function numberAt(tokens: readonly string[], i: number): { value: number | string; next: number } | null {
  const token = tokens[i];
  if (token === undefined) return null;
  if (/^\p{N}+(?:[.,]\p{N}+)*$/u.test(token)) return { value: token, next: i + 1 };
  return numberWords(tokens, i);
}

/** A number starting at `i`, followed by any fraction, decimal or percent reading. */
function readNumber(tokens: readonly string[], i: number): { value: string; next: number } {
  const first = numberAt(tokens, i)!;
  let value = String(first.value);
  let next = first.next;
  const after = tokens[next];
  if (after !== undefined && OVER.has(after)) {
    const denominator = numberAt(tokens, next + 1);
    if (denominator !== null) return { value: `${value}/${denominator.value}`, next: denominator.next };
  }
  if (after !== undefined && DENOMINATORS.has(after)) {
    return { value: `${value}/${DENOMINATORS.get(after)}`, next: next + 1 };
  }
  if (after !== undefined && POINT.has(after)) {
    let digits = "";
    let j = next + 1;
    for (; j < tokens.length; j++) {
      const digit = singleDigit(tokens[j]!);
      if (digit === null) break;
      digits += digit;
    }
    if (digits.length > 0) {
      value = `${value}.${digits}`;
      next = j;
    }
  }
  const unit = tokens[next];
  if (unit !== undefined && PERCENT.has(unit)) return { value: `${value}%`, next: next + 1 };
  if (unit === "por" && tokens[next + 1] === "ciento") return { value: `${value}%`, next: next + 2 };
  return { value, next };
}

function singleDigit(token: string): string | null {
  if (/^\p{N}+$/u.test(token)) return token;
  const word = WORDS.get(token);
  return word !== undefined && word[0] === "unit" ? String(word[1]) : null;
}

/**
 * A whole number written in words starting at `i`: "twenty one", "one hundred and five", "two
 * thousand twenty six", "treinta y dos", "doscientos cuarenta". Each word must be able to follow
 * the previous one, so "one two three" reads as three numbers, not six.
 */
function numberWords(tokens: readonly string[], i: number): { value: number; next: number } | null {
  let total = 0;
  let group = 0;
  let last: WordKind | "hundred" | "scale" | "none" = "none";
  let j = i;
  for (; j < tokens.length; j++) {
    const token = tokens[j]!;
    const following = tokens[j + 1];
    // "one hundred and five", "treinta y dos": a connector only joins two number words.
    if (token === "and" && (last === "hundred" || last === "hundreds" || last === "scale") && following !== undefined && WORDS.has(following)) continue;
    if (token === "y" && last === "tens" && following !== undefined && WORDS.get(following)?.[0] === "unit") continue;
    const word = WORDS.get(token);
    if (word !== undefined) {
      const [kind, value] = word;
      const after = last === "none" || last === "hundred" || last === "hundreds" || last === "scale";
      if (kind === "unit" && !(after || last === "tens")) break;
      if ((kind === "teen" || kind === "tens") && !after) break;
      if (kind === "hundreds" && !(last === "none" || last === "scale")) break;
      group += value;
      last = kind;
      continue;
    }
    if (token === "hundred" && (last === "unit" || last === "teen")) {
      group *= 100;
      last = "hundred";
      continue;
    }
    const scale = SCALES.get(token);
    if (scale !== undefined && (last !== "none" || token === "mil") && last !== "scale") {
      total += (group === 0 ? 1 : group) * scale;
      group = 0;
      last = "scale";
      continue;
    }
    break;
  }
  return last === "none" ? null : { value: total + group, next: j };
}
