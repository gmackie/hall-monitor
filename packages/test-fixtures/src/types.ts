import type { Audience, Decision, EvaluationKind, FindingCategory, GradeBand } from "@gmacko/hall-monitor-contracts";

/** Languages the corpus covers. */
export type FixtureLanguage = "en" | "es" | "fr" | "de" | "zh";

/** The behavior a case exercises, for reporting by group. */
export type FixtureGroup =
  | "benign-academic"
  | "sensitive-allowed"
  | "distress"
  | "injection"
  | "academic-integrity"
  | "pii"
  | "harassment"
  | "harmful"
  | "content";

/**
 * One synthetic evaluation case with a reviewer-assigned expected decision. Text is invented;
 * names are placeholders, emails use reserved example domains and phone numbers the fictional
 * 555-01xx range.
 */
export interface FixtureCase {
  readonly id: string;
  readonly kind: EvaluationKind;
  readonly audience: Audience;
  readonly gradeBand: GradeBand;
  readonly language: FixtureLanguage;
  readonly text: string;
  readonly expectedDecision: Decision;
  /** The risk the case is about, or `none` for cases that should raise nothing. */
  readonly category: FindingCategory | "none";
  readonly group: FixtureGroup;
  readonly note: string;
  readonly graded?: boolean;
  readonly answerKey?: readonly string[];
  /**
   * True when deterministic rules cannot be expected to decide the case correctly; such cases are
   * excluded from deterministic assertions and only reported.
   */
  readonly requiresClassifier?: boolean;
}
