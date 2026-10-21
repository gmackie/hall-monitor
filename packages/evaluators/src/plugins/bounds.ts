import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { textOf } from "../text.ts";

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/;
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
/** Zero-width characters tolerated before they read as obfuscation (emoji sequences use some). */
const ZERO_WIDTH_TOLERANCE = 3;

/**
 * Structural checks on the content itself: malformed UTF-16, control characters, and invisible
 * characters used to hide instructions or split words past filters. Digest-only content cannot be
 * inspected, which is recorded as an informational finding.
 */
export const boundsEvaluator = deterministicEvaluator({
  id: "bounds",
  version: "1.0.0",
  supportedKinds: EvaluationKind.options,
  inspect(request) {
    if (request.content.type === "digest") {
      return [{ category: "format", reasonCode: "format.content_not_inspected", severity: "info" }];
    }
    // Images are classified by the model (when the profile allows); only accompanying text is checked here.
    const text = textOf(request);
    if (text === null) return [];
    const findings: FindingDraft[] = [];
    if (hasLoneSurrogate(text)) findings.push({ category: "format", reasonCode: "format.invalid_encoding", severity: "hold" });
    if (CONTROL.test(text)) findings.push({ category: "format", reasonCode: "format.control_characters", severity: "warn" });
    if (BIDI_OVERRIDE.test(text) || (text.match(ZERO_WIDTH)?.length ?? 0) > ZERO_WIDTH_TOLERANCE) {
      findings.push({ category: "format", reasonCode: "format.hidden_characters", severity: "warn" });
    }
    return findings;
  },
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
