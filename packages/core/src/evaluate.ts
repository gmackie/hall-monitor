import {
  type EvaluationKind,
  EvaluationRequest,
  EvaluationResult,
  type Finding,
  isCompatibleSchemaVersion,
  SCHEMA_VERSION,
  type UsageAttempt,
} from "@gmacko/hall-monitor-contracts";
import { buildReceipt, type PriceBook, priceAttempt } from "@gmacko/hall-monitor-costing";
import { type EvaluatorBundle, type EvaluatorPlugin, type EvaluatorSignals, runPlugins } from "@gmacko/hall-monitor-evaluators";
import { type ModerationMode, type PolicyProfile, type ResolutionFlags, resolveDecision } from "@gmacko/hall-monitor-policy";
import { HallMonitorError } from "./errors.ts";

/** Looks up a pinned policy profile revision; undefined when it does not exist. */
export type PolicyLookup = (profileId: string, revision: string) => PolicyProfile | undefined | Promise<PolicyProfile | undefined>;

/** Generates opaque identifiers for results and receipts. */
export interface IdSource {
  evaluationId(): string;
  receiptId(): string;
}

/** Everything {@link evaluate} needs from its host. */
export interface EvaluateDeps {
  readonly policies: PolicyLookup;
  readonly bundle: EvaluatorBundle;
  /** The model classifier; without one, a required classification is treated as unavailable. */
  readonly classifier?: EvaluatorPlugin;
  /** Prices any attempt an evaluator left unpriced; receipts are stated in this book. */
  readonly priceBook: PriceBook;
  readonly clock: () => Date;
  readonly ids: IdSource;
  /**
   * Admission control for classification spend against the safety budget. Returning false skips
   * the classifier and, for required moderation, resolves as budget-exhausted.
   */
  readonly admitClassification?: (request: EvaluationRequest) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
}

const PURPOSE: Readonly<Record<EvaluationKind, string>> = {
  "interaction.input": "moderation.input",
  "interaction.output": "moderation.output",
  "content.candidate": "content.review",
  "assessment.evaluator-result": "assessment.review",
};

/**
 * Evaluates one request: validates it, runs the deterministic bundle, classifies when policy
 * requires it and the deterministic findings are not already decisive, resolves the decision and
 * builds the cost receipt (null when no provider was called).
 *
 * The result is content-free by construction: it is assembled only from findings, reason codes,
 * revisions and counters, and validated against the wire schema before it is returned. Errors are
 * thrown as {@link HallMonitorError} with a content-free message.
 */
export async function evaluate(input: unknown, deps: EvaluateDeps): Promise<EvaluationResult> {
  const request = parseEvaluationRequest(input);
  const profile = await deps.policies(request.policy.profileId, request.policy.revision);
  if (profile === undefined) {
    throw new HallMonitorError("policy_not_found", `policy ${request.policy.profileId}@${request.policy.revision} is not available`);
  }
  const context = { profile, signal: deps.signal ?? new AbortController().signal };

  const deterministic = await runPlugins(deps.bundle.plugins, request, context);
  const findings: Finding[] = [...deterministic.findings];
  const attempts: UsageAttempt[] = [...deterministic.attempts];
  let flags: ResolutionFlags = { ...deterministic.signals };

  const mode = moderationMode(profile, request.evaluationKind);
  const decisive = findings.some((finding) => finding.severity === "block" || finding.severity === "support");
  if (mode !== "off" && request.content.type === "text" && !decisive) {
    const classified = await classify(request, deps, context, mode);
    findings.push(...classified.findings);
    attempts.push(...classified.attempts);
    flags = { ...flags, ...classified.flags };
  }

  const resolution = resolveDecision(profile, findings, request.context, flags);
  const at = deps.clock();
  const priced = attempts.map((attempt) =>
    attempt.grossUsdNano === undefined && attempt.state !== "unknown" ? priceAttempt(deps.priceBook, attempt, { at }).attempt : attempt,
  );
  const receipt =
    priced.length === 0
      ? null
      : buildReceipt({
          receiptId: deps.ids.receiptId(),
          tenantId: request.source.tenantId,
          product: request.source.product,
          costCenterId: request.context.costCenterId,
          logicalRequestId: request.requestId,
          ...(request.context.parentRequestId === undefined ? {} : { parentRequestId: request.context.parentRequestId }),
          createdAt: at.toISOString(),
          purpose: PURPOSE[request.evaluationKind],
          attempts: priced,
        });

  return EvaluationResult.parse({
    schemaVersion: SCHEMA_VERSION,
    evaluationId: deps.ids.evaluationId(),
    requestId: request.requestId,
    decision: resolution.decision,
    reasonCodes: resolution.reasonCodes,
    findings,
    uncertain: resolution.uncertain,
    policyRevision: profile.revision,
    evaluatorBundleRevision: bundleRevision(deps),
    resolverVersion: resolution.resolverVersion,
    receipt,
    ...(resolution.degraded === undefined ? {} : { degraded: { reason: resolution.degraded } }),
  });
}

/**
 * Validates an untrusted evaluation request: the schema version first (so an unsupported version
 * is reported as such), then the full schema. Throws {@link HallMonitorError} naming field paths
 * only, never values, since values may be content.
 */
export function parseEvaluationRequest(input: unknown): EvaluationRequest {
  const version = typeof input === "object" && input !== null ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version !== "string") throw new HallMonitorError("invalid_request", "schemaVersion is required");
  if (!isCompatibleSchemaVersion(version)) throw new HallMonitorError("unsupported_schema", "schemaVersion is not supported");
  const parsed = EvaluationRequest.safeParse(input);
  if (!parsed.success) {
    // Issue paths only: zod messages can quote the offending value, which may be content.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new HallMonitorError("invalid_request", `invalid fields: ${fields.join(", ")}`);
  }
  return parsed.data;
}

/** Which moderation setting governs a kind: output checks use the output stage, all else input. */
function moderationMode(profile: PolicyProfile, kind: EvaluationKind): ModerationMode {
  return kind === "interaction.output" ? profile.outputModeration : profile.inputModeration;
}

async function classify(
  request: EvaluationRequest,
  deps: EvaluateDeps,
  context: { profile: PolicyProfile; signal: AbortSignal },
  mode: Exclude<ModerationMode, "off">,
): Promise<{ findings: readonly Finding[]; attempts: readonly UsageAttempt[]; flags: ResolutionFlags }> {
  const required = mode === "required";
  const none = { findings: [], attempts: [] };
  if (deps.classifier === undefined) return { ...none, flags: required ? { classifierUnavailable: true } : {} };
  if (deps.admitClassification !== undefined && !(await deps.admitClassification(request))) {
    return { ...none, flags: required ? { budgetExhausted: true } : {} };
  }
  let output: { findings: readonly Finding[]; attempts: readonly UsageAttempt[]; signals: EvaluatorSignals };
  try {
    output = await runPlugins([deps.classifier], request, context);
  } catch {
    output = { ...none, signals: { classifierUnavailable: true } };
  }
  // Optional moderation does not fail closed when the classifier is down.
  const { classifierUnavailable: _unavailable, classifierTimedOut: _timedOut, ...rest } = output.signals;
  const flags: ResolutionFlags = required ? output.signals : rest;
  return { findings: output.findings, attempts: output.attempts, flags };
}

function bundleRevision(deps: EvaluateDeps): string {
  return deps.classifier === undefined ? deps.bundle.revision : `${deps.bundle.revision}:${deps.classifier.id}-${deps.classifier.version}`;
}
