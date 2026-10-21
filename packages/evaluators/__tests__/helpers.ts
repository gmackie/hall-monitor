import type { EvaluationKind, EvaluationRequest, Finding } from "@gmacko/hall-monitor-contracts";
import { BUILTIN_PROFILES } from "@gmacko/hall-monitor-policy";
import type { EvaluatorPlugin } from "../src/index.ts";

/** Options for a synthetic test request. */
export interface RequestOptions {
  kind?: EvaluationKind;
  audience?: "student" | "educator" | "public";
  gradeBand?: "K-2" | "3-5" | "6-8" | "9-12" | "adult";
  answerKey?: string[];
}

/** A synthetic text evaluation request. */
export function request(text: string, options: RequestOptions = {}): EvaluationRequest {
  return {
    schemaVersion: "1.0",
    requestId: "req_test",
    idempotencyKey: "idem_test",
    source: { product: "other", tenantId: "tenant_test", surface: "test" },
    policy: { profileId: "student-9-12", revision: "builtin-1" },
    context: {
      audience: options.audience ?? "student",
      costCenterId: "cc_test",
      ...(options.gradeBand === undefined ? {} : { gradeBand: options.gradeBand }),
    },
    evaluationKind: options.kind ?? "interaction.input",
    content: { type: "text", text, ...(options.answerKey === undefined ? {} : { answerKey: options.answerKey }) },
  };
}

/** Runs one plugin and returns its findings. */
export async function findingsOf(plugin: EvaluatorPlugin, text: string, options: RequestOptions = {}): Promise<Finding[]> {
  const output = await plugin.evaluate(request(text, options), {
    profile: BUILTIN_PROFILES["student-9-12"]!,
    signal: new AbortController().signal,
  });
  return [...output.findings];
}

/** The reason codes of a plugin's findings with the given severity. */
export async function codesOf(plugin: EvaluatorPlugin, text: string, options: RequestOptions = {}): Promise<string[]> {
  return (await findingsOf(plugin, text, options)).filter((f) => f.severity !== "info").map((f) => `${f.reasonCode}:${f.severity}`);
}
