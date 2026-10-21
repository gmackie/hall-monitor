import { type EvaluationRequest, SCHEMA_VERSION } from "@gmacko/hall-monitor-contracts";
import type { FixtureCase } from "./types.ts";

/**
 * The built-in policy profile a case is evaluated under: published content for candidates,
 * the educator profile for educators, and the student profile for the learner's band (bands
 * below 6-8 use the stricter 6-8 profile).
 */
export function fixtureProfileId(fixture: FixtureCase): string {
  if (fixture.kind === "content.candidate") return "published-content";
  if (fixture.audience !== "student") return "educator";
  return fixture.gradeBand === "9-12" || fixture.gradeBand === "adult" ? "student-9-12" : "student-6-8";
}

/** A synthetic evaluation request for a case. */
export function fixtureRequest(fixture: FixtureCase): EvaluationRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: `req_${fixture.id}`,
    idempotencyKey: `idem_${fixture.id}`,
    source: { product: "other", tenantId: "tenant_fixture", surface: "fixture" },
    policy: { profileId: fixtureProfileId(fixture), revision: "builtin-1" },
    context: {
      audience: fixture.audience,
      gradeBand: fixture.gradeBand,
      costCenterId: "cc_fixture",
      ...(fixture.graded === undefined ? {} : { graded: fixture.graded }),
    },
    evaluationKind: fixture.kind,
    content: {
      type: "text",
      text: fixture.text,
      ...(fixture.answerKey === undefined ? {} : { answerKey: [...fixture.answerKey] }),
    },
  };
}
