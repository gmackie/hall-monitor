import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { isVoiceLineSurface } from "@gmacko/hall-monitor-policy";
import { foldForMatching } from "./text.ts";

/** One spoken line inside a voice-line request's text, with its offset into that text. */
export interface SpokenLine {
  readonly text: string;
  readonly offset: number;
}

/**
 * The spoken lines of a voice-line request, or null when the request is not on a voice-line
 * surface or carries no text.
 *
 * Wire convention for `voice_line.*` text: lines are separated by a blank line; within each
 * segment the first line is what the voice says (the spoken form, numbers and symbols already
 * verbalized) and any following lines are the on-screen caption, which is not spoken. A segment
 * with one line is spoken as written. Speakability and spoken answer leakage read only the spoken
 * lines, so a caption's "3/4" is not mistaken for an unverbalized symbol.
 */
export function spokenLinesOf(request: EvaluationRequest): SpokenLine[] | null {
  if (!isVoiceLineSurface(request.source.surface) || request.content.type !== "text") return null;
  const text = request.content.text;
  const lines: SpokenLine[] = [];
  let offset = 0;
  for (const segment of text.split(/(\r?\n[ \t]*\r?\n)/)) {
    if (/^\r?\n[ \t]*\r?\n$/.test(segment)) {
      offset += segment.length;
      continue;
    }
    const first = segment.split(/\r?\n/, 1)[0] ?? "";
    const lead = first.length - first.trimStart().length;
    const spoken = first.trim();
    if (spoken.length > 0) lines.push({ text: spoken, offset: offset + lead });
    offset += segment.length;
  }
  return lines;
}

/**
 * {@link foldForMatching} with diacritics removed, so lexicons can be written once for `qué` and
 * `que`. Offsets into it do not map back to the original text.
 */
export function foldPlain(text: string): string {
  return foldForMatching(text).normalize("NFD").replace(/\p{M}/gu, "");
}
