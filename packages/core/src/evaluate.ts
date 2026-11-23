import {
  type ClassifierRoute,
  type ClassifierSkipReason,
  type EnforcementMode,
  type FamilyMode,
  type EvaluationKind,
  EvaluationRequest,
  EvaluationResult,
  type Finding,
  isCompatibleSchemaVersion,
  SCHEMA_VERSION,
  type UsageAttempt,
} from "@gmacko/hall-monitor-contracts";
import { buildReceipt, type PriceBook, priceAttempt } from "@gmacko/hall-monitor-costing";
import { type ClassifierTrace, type EvaluatorBundle, type EvaluatorPlugin, type EvaluatorSignals, runPlugins } from "@gmacko/hall-monitor-evaluators";
import {
  MODEL_FAMILIES,
  type ModelFamily,
  type ModerationMode,
  type PolicyProfile,
  type Resolution,
  type ResolutionContext,
  type ResolutionFlags,
  resolveDecision,
  routeFor,
  type ShadowPermissions,
} from "@gmacko/hall-monitor-policy";
import { HallMonitorError } from "./errors.ts";
import { applyEnforcement } from "./shadow.ts";

/** Looks up a pinned policy profile revision; undefined when it does not exist. */
export type PolicyLookup = (profileId: string, revision: string) => PolicyProfile | undefined | Promise<PolicyProfile | undefined>;

/** Generates opaque identifiers for results and receipts. */
export interface IdSource {
  evaluationId(): string;
  receiptId(): string;
}

/** Turns findings into a decision; {@link resolveDecision} unless a replay or diff pins another table. */
export type DecisionResolver = (
  profile: PolicyProfile,
  findings: readonly Finding[],
  context: ResolutionContext,
  flags: ResolutionFlags,
) => Resolution;

/**
 * How the host applies the resolved decision. Hosts derive it from their own configuration for
 * the verified tenant; it is never read from the request.
 */
export interface EnforcementOptions extends ShadowPermissions {
  readonly mode: EnforcementMode;
  /** Called when shadow mode was configured but the profile may not be shadowed, so it was enforced. */
  readonly onShadowRefused?: (profile: PolicyProfile) => void;
}

/** Everything {@link evaluate} needs from its host. */
export interface EvaluateDeps {
  readonly policies: PolicyLookup;
  readonly bundle: EvaluatorBundle;
  /** The model classifier; without one, a required classification is treated as unavailable. */
  readonly classifier?: EvaluatorPlugin;
  /**
   * Further model families (e.g. Clairic), run in parallel with `classifier` when the profile's
   * routing enables them for the kind (see `PolicyProfile.routing`).
   */
  readonly classifiers?: readonly EvaluatorPlugin[];
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
  /** Defaults to enforcing every decision. */
  readonly enforcement?: EnforcementOptions;
  /** Defaults to {@link resolveDecision}; overridden only to replay or diff another resolver version. */
  readonly resolve?: DecisionResolver;
}

/** Evaluator id of findings the core records itself. */
export const CORE_EVALUATOR_ID = "hall-monitor-core";
/** Version of the core's own findings. */
export const CORE_EVALUATOR_VERSION = "1.0.0";
/** Reason code recorded when image content is not classified because its profile leaves image moderation off. */
export const IMAGE_MODERATION_DISABLED = "hall_monitor.image_moderation_disabled";

const PURPOSE: Readonly<Record<EvaluationKind, string>> = {
  "interaction.input": "moderation.input",
  "interaction.output": "moderation.output",
  "content.candidate": "content.review",
  "assessment.evaluator-result": "assessment.review",
};

/**
 * Evaluates one request: validates it, runs the deterministic bundle, classifies when policy
 * requires it and the deterministic findings are not already decisive, resolves the decision and
 * builds the cost receipt (null when no provider was called). Image content is classified only
 * under a profile with `imageModeration`; otherwise it is recorded as
 * {@link IMAGE_MODERATION_DISABLED} and, where moderation is required, resolved as an unavailable
 * classifier, so a fail-closed profile holds it. In shadow mode the decision is then
 * recorded rather than enforced (see {@link applyEnforcement}).
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
  const unmoderatedImages = request.content.type === "image" && profile.imageModeration !== true;
  const routes: ClassifierRoute[] = [];
  // Families routed for this kind under the profile, each with its mode. A family the profile turns
  // off is recorded as skipped; an unknown plugin family runs like the legacy single classifier.
  const routed: { plugin: EvaluatorPlugin; mode: FamilyMode }[] = [];
  for (const plugin of classifiersOf(deps)) {
    const family = familyOf(plugin);
    const routing = isModelFamily(family) ? routeFor(profile, family, request.evaluationKind) : { mode: "enforce" as const };
    if (routing === null) routes.push(classifierRoute(plugin, "enforce", undefined, "profile_disabled"));
    else routed.push({ plugin, mode: routing.mode });
  }
  const skipped = (reason: ClassifierSkipReason) => {
    for (const { plugin, mode: familyMode } of routed) routes.push(classifierRoute(plugin, familyMode, undefined, reason));
  };
  if (mode === "off") skipped("moderation_off");
  else if (unmoderatedImages) skipped("image_moderation_disabled");
  else if (request.content.type === "digest") skipped("digest_content");
  else if (decisive) skipped("deterministic_decisive");
  if (mode !== "off" && unmoderatedImages) {
    findings.push({
      evaluatorId: CORE_EVALUATOR_ID,
      evaluatorVersion: CORE_EVALUATOR_VERSION,
      category: "format",
      reasonCode: IMAGE_MODERATION_DISABLED,
      severity: "info",
    });
    if (mode === "required") flags = { ...flags, classifierUnavailable: true };
  } else if (mode !== "off" && request.content.type !== "digest" && !decisive) {
    const classified = await classify(request, deps, routed, context, mode);
    findings.push(...classified.findings);
    attempts.push(...classified.attempts);
    flags = { ...flags, ...classified.flags };
    routes.push(...classified.routes);
  }

  const resolution = (deps.resolve ?? resolveDecision)(profile, findings, request.context, flags);
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

  const result = EvaluationResult.parse({
    schemaVersion: SCHEMA_VERSION,
    evaluationId: deps.ids.evaluationId(),
    requestId: request.requestId,
    decision: resolution.decision,
    reasonCodes: resolution.reasonCodes,
    findings,
    uncertain: resolution.uncertain,
    policyRevision: profile.revision,
    evaluatorBundleRevision: bundleRevision(deps.bundle, routed.map((entry) => entry.plugin)),
    resolverVersion: resolution.resolverVersion,
    receipt,
    ...(resolution.degraded === undefined ? {} : { degraded: { reason: resolution.degraded } }),
    route: { classifiers: inPluginOrder(routes, classifiersOf(deps)) },
  });
  return applyEnforcement(result, profile, deps.enforcement);
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

/** Route entries in the order the host supplied the plugins, so the route reads the same every time. */
function inPluginOrder(routes: readonly ClassifierRoute[], plugins: readonly EvaluatorPlugin[]): ClassifierRoute[] {
  const order = new Map(plugins.map((plugin, index) => [plugin.id, index]));
  return [...routes].sort((a, b) => (order.get(a.evaluatorId) ?? 0) - (order.get(b.evaluatorId) ?? 0));
}

/** Every model-backed evaluator the host supplied: the legacy single slot first, then the rest. */
function classifiersOf(deps: EvaluateDeps): readonly EvaluatorPlugin[] {
  return [...(deps.classifier === undefined ? [] : [deps.classifier]), ...(deps.classifiers ?? [])];
}

function familyOf(plugin: EvaluatorPlugin): string {
  return plugin.family ?? plugin.id;
}

function isModelFamily(family: string): family is ModelFamily {
  return (MODEL_FAMILIES as readonly string[]).includes(family);
}

/**
 * Runs every routed family in parallel. Only `enforce` families produce findings and signals for
 * the decision; a `shadow` family's findings are recorded on its route entry and its failures are
 * ignored, though its provider attempts are still receipted, since they were billed. A required
 * stage with no enforcing family is resolved as an unavailable classifier, as before routing.
 */
async function classify(
  request: EvaluationRequest,
  deps: EvaluateDeps,
  routed: readonly { plugin: EvaluatorPlugin; mode: FamilyMode }[],
  context: { profile: PolicyProfile; signal: AbortSignal },
  mode: Exclude<ModerationMode, "off">,
): Promise<{ findings: readonly Finding[]; attempts: readonly UsageAttempt[]; flags: ResolutionFlags; routes: readonly ClassifierRoute[] }> {
  const required = mode === "required";
  const unavailable: ResolutionFlags = required ? { classifierUnavailable: true } : {};
  if (routed.length === 0) return { findings: [], attempts: [], flags: unavailable, routes: [] };
  if (deps.admitClassification !== undefined && !(await deps.admitClassification(request))) {
    return {
      findings: [],
      attempts: [],
      flags: required && routed.some((entry) => entry.mode === "enforce") ? { budgetExhausted: true } : {},
      routes: routed.map(({ plugin, mode: familyMode }) => classifierRoute(plugin, familyMode, undefined, "budget_exhausted")),
    };
  }
  const outcomes = await Promise.all(routed.map(async ({ plugin, mode: familyMode }) => {
    if (!plugin.supportedKinds.includes(request.evaluationKind)) {
      return { familyMode, ran: false, output: undefined, route: classifierRoute(plugin, familyMode, undefined, "kind_not_routed") };
    }
    if (plugin.supportsContent !== undefined && !plugin.supportsContent(request)) {
      return { familyMode, ran: false, output: undefined, route: classifierRoute(plugin, familyMode, undefined, "content_not_supported") };
    }
    let output: { findings: readonly Finding[]; attempts: readonly UsageAttempt[]; signals: EvaluatorSignals; trace?: ClassifierTrace };
    try {
      const raw = await plugin.evaluate(request, context);
      output = { findings: raw.findings, attempts: raw.attempts, signals: raw.signals ?? {}, ...(raw.trace === undefined ? {} : { trace: raw.trace }) };
    } catch {
      output = { findings: [], attempts: [], signals: { classifierUnavailable: true } };
    }
    const route = classifierRoute(plugin, familyMode, output.trace, undefined, familyMode === "shadow" ? output.findings : undefined);
    return { familyMode, ran: true, output, route };
  }));

  const findings: Finding[] = [];
  const attempts: UsageAttempt[] = [];
  let signals: EvaluatorSignals = {};
  let enforcing = 0;
  for (const outcome of outcomes) {
    if (outcome.output !== undefined) attempts.push(...outcome.output.attempts);
    if (outcome.familyMode !== "enforce" || !outcome.ran || outcome.output === undefined) continue;
    enforcing++;
    findings.push(...outcome.output.findings);
    signals = { ...signals, ...Object.fromEntries(Object.entries(outcome.output.signals).filter(([, value]) => value === true)) };
  }
  // A required stage needs an answer from a family that decides; shadow-only routing gives none.
  if (enforcing === 0 && routed.every((entry) => entry.mode === "shadow")) signals = { ...signals, ...unavailable };
  // Optional moderation does not fail closed when the classifier is down.
  const { classifierUnavailable: _unavailable, classifierTimedOut: _timedOut, ...rest } = signals;
  const flags: ResolutionFlags = required ? signals : rest;
  return { findings, attempts, flags, routes: outcomes.map((outcome) => outcome.route) };
}

/** A family's route entry: what it called, or why it was skipped. */
function classifierRoute(
  plugin: EvaluatorPlugin,
  mode: FamilyMode,
  trace: ClassifierTrace | undefined,
  skipReason?: ClassifierSkipReason,
  shadowFindings?: readonly Finding[],
): ClassifierRoute {
  const deniedEverything = trace !== undefined && trace.calls.length > 0 && trace.calls.every((call) => call.outcome === "denied");
  const reason = skipReason ?? (deniedEverything ? "not_authorized" : undefined);
  return {
    family: trace?.family ?? familyOf(plugin),
    evaluatorId: plugin.id,
    evaluatorVersion: plugin.version,
    status: reason === undefined ? "ran" : "skipped",
    ...(reason === undefined ? {} : { skipReason: reason }),
    mode,
    calibrationRevision: trace?.calibrationRevision ?? null,
    calls: [...(trace?.calls ?? [])],
    escalated: trace?.escalated ?? false,
    ...(trace?.escalationReason === undefined ? {} : { escalationReason: trace.escalationReason }),
    ...(trace?.fellBack === true ? { fellBack: true } : {}),
    ...(shadowFindings === undefined || shadowFindings.length === 0 ? {} : { shadowFindings: shadowFindings.slice(0, 64) }),
  };
}

/**
 * The bundle revision results carry: the deterministic bundle, then each routed model evaluator.
 * With Clef alone this is `base:clef-<version>`, exactly as before routing; each further routed
 * family appends `:<id>-<version>`.
 */
export function bundleRevision(bundle: Pick<EvaluatorBundle, "revision">, plugins: readonly Pick<EvaluatorPlugin, "id" | "version">[]): string {
  return plugins.length === 0 ? bundle.revision : `${bundle.revision}:${plugins.map((plugin) => `${plugin.id}-${plugin.version}`).join(":")}`;
}
