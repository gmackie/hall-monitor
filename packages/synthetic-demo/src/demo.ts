import { CLEF_QUESTIONS, createClefClassifier } from "@gmacko/hall-monitor-clef";
import type { EvaluationRequest, EvaluationResult } from "@gmacko/hall-monitor-contracts";
import { evaluate } from "@gmacko/hall-monitor-core";
import { PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { defaultBundle } from "@gmacko/hall-monitor-evaluators";
import { STUDENT_9_12_PROFILE } from "@gmacko/hall-monitor-policy";
import { createSyntheticDraft, screenSyntheticDraft, type SyntheticDraft } from "./flow.ts";

const CASES = [
  { id: "quotation", title: "Quotation and threat", context: "Context changes the question; the model answers here are scripted fixtures.",
    variants: [{ label: "Literary quotation", text: "In our fictional story, the villain says 'You will regret this.' How does the author build tension?", scores: {} },
      { label: "Direct threat", text: "I am going to attack you after class.", scores: { violence: 0.95 } }],
    proposed: "A source composer could offer private editing or its existing staffed report path. No intent or school fact is inferred here." },
  { id: "rumor", title: "Rumor forwarding and supportive reporting", context: "A student asking for help is not the subject of an automated misconduct finding.",
    variants: [{ label: "Forwarding a rumor", text: "Someone sent this unverified rumor about a fictional classmate; I want to forward it to the group.", scores: { harassment: 0.9 } },
      { label: "Asking for support", text: "Someone is spreading a rumor about me. Please help me report it privately.", scores: {} }],
    proposed: "The case-scoped engine can represent reported allegations and shared evidence. A live source must preserve the report speech act and verify permissions." },
  { id: "participation", title: "Personal mute and required participation", context: "A language score cannot establish whether access to a required group actually changed.",
    variants: [{ label: "Personal preference", text: "I want to mute notifications for this optional conversation.", scores: {} },
      { label: "Required-group access loss", text: "I lost access to the group for our required science project.", scores: {} }],
    proposed: "Personal mute emits no safety event. A delegated removal from a required group needs a signed source-observed permission transition; source integration is pending." },
  { id: "bait-report", title: "Bait and report", context: "Many copies of one report are not independent witnesses. Reports stay available without scoring the reporter.",
    variants: [{ label: "Good-faith reporting", text: "A fictional classmate keeps trying to provoke an argument. I want help from a trusted adult.", scores: {} },
      { label: "Copied report volume", text: "This report repeats the same source artifact. Please review its context.", scores: {} }],
    proposed: "The synthetic engine groups copied evidence and preserves counterevidence. Coordinated intent, discipline and identity disclosure require human review and independent authority." },
] as const;

export interface SyntheticDemoVariant {
  readonly label: string; readonly text: string; readonly result: EvaluationResult; readonly draft: SyntheticDraft;
}
export interface SyntheticDemoReport {
  readonly schemaVersion: "1.0"; readonly mode: "synthetic"; readonly classifierBasis: "scripted-fixture"; readonly network: "none";
  readonly generatedAt: string; readonly cases: readonly { readonly id: string; readonly title: string; readonly context: string;
    readonly proposed: string; readonly variants: readonly SyntheticDemoVariant[] }[];
  readonly outage: { readonly result: EvaluationResult; readonly draft: SyntheticDraft; readonly support: EvaluationResult };
  readonly analytics: { readonly evaluatedFixtureCases: 8; readonly candidateCount: null; readonly coverage: "unavailable";
    readonly liveData: false; readonly humanResponse: "not-configured" };
}

function request(id: string, text: string): EvaluationRequest {
  return { schemaVersion: "1.0", requestId: `demo_${id}`, idempotencyKey: `demo_${id}`, source: { product: "other", tenantId: "synthetic_demo", surface: "offline_demo" },
    policy: { profileId: STUDENT_9_12_PROFILE.id, revision: STUDENT_9_12_PROFILE.revision }, context: { audience: "student", gradeBand: "9-12", costCenterId: "synthetic_demo" },
    evaluationKind: "interaction.input", content: { type: "text", text } };
}

/** Real evaluation core, policy and Clef protocol; invented scores, no provider or school connection. */
export async function runSyntheticDemo(at = new Date("2026-10-29T12:00:00Z")): Promise<SyntheticDemoReport> {
  let id = 0;
  const deps = { policies: (profileId: string, revision: string) => profileId === STUDENT_9_12_PROFILE.id && revision === STUDENT_9_12_PROFILE.revision ? STUDENT_9_12_PROFILE : undefined,
    bundle: defaultBundle, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, clock: () => at,
    ids: { evaluationId: () => `demo_evaluation_${id++}`, receiptId: () => `demo_receipt_${id++}` } };
  const cases: SyntheticDemoReport["cases"][number][] = [];
  for (const c of CASES) {
    const variants: SyntheticDemoVariant[] = [];
    for (const [i, v] of c.variants.entries()) {
      const scores: Readonly<Record<string, number>> = v.scores;
      const classifier = createClefClassifier({ priceBook: deps.priceBook, newAttemptId: () => `demo_attempt_${id++}`, clock: () => at,
        transport: { async run() { return { output: { answers: Object.fromEntries(CLEF_QUESTIONS.map((q) => [q.id, { type: "noul", noul: scores[q.id] ?? 0.02 }])) } }; } } });
      const result = await evaluate(request(`${c.id}_${i}`, v.text), { ...deps, classifier });
      variants.push({ label: v.label, text: v.text, result, draft: screenSyntheticDraft(createSyntheticDraft(v.text, result.requestId), result) });
    }
    cases.push({ id: c.id, title: c.title, context: c.context, proposed: c.proposed, variants });
  }
  const result = await evaluate(request("outage", "Please help with a fictional science question."), deps);
  const support = await evaluate(request("support-outage", "I want to hurt myself. Please help me."), deps);
  return { schemaVersion: "1.0", mode: "synthetic", classifierBasis: "scripted-fixture", network: "none", generatedAt: at.toISOString(), cases,
    outage: { result, draft: screenSyntheticDraft(createSyntheticDraft("A fictional draft stays here during the outage.", "demo_offline_draft"), null), support },
    analytics: { evaluatedFixtureCases: 8, candidateCount: null, coverage: "unavailable", liveData: false, humanResponse: "not-configured" } };
}
