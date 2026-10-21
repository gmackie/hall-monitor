import { Audience, Decision, EvaluationKind, FindingCategory, GradeBand, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { CORPUS, type FixtureCase, fixtureProfileId } from "@gmacko/hall-monitor-test-fixtures";
import { z } from "zod";

/**
 * One line of a synthetic case file (JSONL). It is a {@link FixtureCase} plus `synthetic: true`,
 * the author's attestation that the text was invented for testing and describes no real person or
 * learner. Lines without it are refused: real traffic must never be fed to this tool.
 */
export const ShadowCase = z.strictObject({
  synthetic: z.literal(true),
  id: OpaqueId,
  kind: EvaluationKind,
  audience: Audience,
  gradeBand: GradeBand,
  language: z.enum(["en", "es", "fr", "de", "zh"]),
  text: z.string().min(1).max(32_000),
  expectedDecision: Decision,
  category: z.union([FindingCategory, z.literal("none")]),
  group: z.enum(["benign-academic", "sensitive-allowed", "distress", "injection", "academic-integrity", "pii", "harassment", "harmful", "content"]),
  note: z.string().max(500).default(""),
  graded: z.boolean().optional(),
  answerKey: z.array(z.string().min(1).max(500)).max(100).optional(),
  requiresClassifier: z.boolean().optional(),
});
/** One line of a synthetic case file. */
export type ShadowCase = z.input<typeof ShadowCase>;

/** A set of cases and where they came from, for the report header. */
export interface CaseSet {
  /** `builtin` for the frozen corpus, otherwise the file name (never its contents). */
  readonly source: string;
  readonly cases: readonly FixtureCase[];
}

/** The frozen synthetic corpus from `@gmacko/hall-monitor-test-fixtures`. */
export const BUILTIN_CASES: CaseSet = Object.freeze({ source: "builtin", cases: CORPUS });

/**
 * Parses a JSONL file of synthetic cases. Blank lines are skipped. Errors name the line number and
 * field paths only, never values, since values are text. Case ids must be unique.
 */
export function parseCasesJsonl(source: string, text: string): CaseSet {
  const cases: FixtureCase[] = [];
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1}: not valid JSON`);
    }
    const parsed = ShadowCase.safeParse(value);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
      throw new Error(`line ${index + 1}: invalid fields: ${fields.join(", ")}`);
    }
    const { synthetic: _synthetic, answerKey, ...fixture } = parsed.data;
    if (ids.has(fixture.id)) throw new Error(`line ${index + 1}: duplicate case id`);
    ids.add(fixture.id);
    cases.push({ ...fixture, ...(answerKey === undefined ? {} : { answerKey }) } as FixtureCase);
  }
  if (cases.length === 0) throw new Error("no cases found");
  return { source, cases };
}

/** The cases evaluated under one of `profileIds` (every case when the list is empty). */
export function selectCases(set: CaseSet, profileIds: readonly string[]): CaseSet {
  if (profileIds.length === 0) return set;
  return { source: set.source, cases: set.cases.filter((fixture) => profileIds.includes(fixtureProfileId(fixture))) };
}
