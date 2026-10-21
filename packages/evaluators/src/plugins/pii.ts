import type { EvaluationRequest, Severity, Span } from "@gmacko/hall-monitor-contracts";
import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { deterministicEvaluator, type FindingDraft } from "../plugin.ts";
import { spansOf } from "../text.ts";

/** At most this many spans are reported per kind of identifier. */
const MAX_SPANS_PER_KIND = 20;

interface Detector {
  readonly reasonCode: string;
  readonly pattern: RegExp;
  /** Identifiers that enable fraud or identity theft are held wherever they appear. */
  readonly alwaysHold: boolean;
  readonly accept?: (match: string) => boolean;
}

// Ordered by priority: an overlapping lower-priority match (a card number that also looks like a
// phone number) is dropped.
const DETECTORS: readonly Detector[] = [
  {
    reasonCode: "privacy.payment_card",
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    alwaysHold: true,
    accept: (match) => passesLuhn(match.replace(/\D/g, "")),
  },
  {
    reasonCode: "privacy.government_id",
    pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    alwaysHold: true,
  },
  { reasonCode: "privacy.email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, alwaysHold: false },
  {
    reasonCode: "privacy.phone",
    pattern: /(?<!\d[ .-]?)(?:(?:\+1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}|\+\d{1,3}(?:[ .-]?\d{2,4}){2,4})(?![ .-]?\d)/g,
    alwaysHold: false,
  },
  {
    reasonCode: "privacy.street_address",
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Circle)\b\.?/g,
    alwaysHold: false,
  },
];

/**
 * Detects personal identifiers with their spans: payment cards (Luhn-checked), US SSN-shaped
 * numbers, emails, phone numbers and street addresses. A learner sharing contact details is
 * coached (`warn`); identifiers in model output or publishable content, and any card or SSN, are
 * held.
 */
export const piiEvaluator = deterministicEvaluator({
  id: "pii",
  version: "1.0.0",
  supportedKinds: EvaluationKind.options,
  inspect(request) {
    if (request.content.type !== "text") return [];
    const text = request.content.text;
    const taken: Span[] = [];
    const findings: FindingDraft[] = [];
    for (const detector of DETECTORS) {
      const spans = spansOf(text, detector.pattern, detector.accept)
        .filter((span) => !taken.some((other) => span.start < other.end && other.start < span.end))
        .slice(0, MAX_SPANS_PER_KIND);
      taken.push(...spans);
      const severity = severityFor(detector, request);
      for (const span of spans) findings.push({ category: "privacy", reasonCode: detector.reasonCode, severity, span });
    }
    return findings;
  },
});

function severityFor(detector: Detector, request: EvaluationRequest): Severity {
  return detector.alwaysHold || request.evaluationKind !== "interaction.input" ? "hold" : "warn";
}

/** The Luhn checksum used by payment card numbers. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
