import { randomUUID } from "node:crypto";
import { EvaluationRequest, EvaluationResult, ReceiptRecord } from "@gmacko/hall-monitor-contracts";

const READY_CHECKS = ["authentication", "policyOverlays", "tenantModes", "idempotencyStore", "replayGuard", "classifier", "decisionPack", "governanceConfig"] as const;
const PHASES = ["health", "readiness", "evaluation", "replay", "receipt"] as const;
type Phase = typeof PHASES[number];
type Failure = "request-failed" | "status" | "revision" | "collection-enabled" | "response" | "content-reflected";
const MAX_RESPONSE = 256 * 1024;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: readonly string[]) => Object.keys(x).length === names.length && names.every((n) => Object.hasOwn(x, n));
const label = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);

export interface SyntheticAcceptanceCredentials {
  readonly mode: "synthetic";
  readonly tenant: string;
  readonly source: "educateos" | "playtrek" | "hall-monitor";
  readonly tokens: { readonly ready: string; readonly evaluate: string; readonly replay: string; readonly receipt: string };
}
export interface AcceptanceTarget { readonly url: string; readonly expectedCommit: string; readonly deploymentId: string }
export interface AcceptanceEvidence {
  readonly schemaVersion: 1; readonly mode: "synthetic"; readonly target: AcceptanceTarget;
  readonly deploymentMetadata: "operator-supplied-verify-in-forgegraph"; readonly checkedAt: string;
  readonly passed: boolean; readonly productionEnrollmentApproved: false;
  readonly checks: readonly { readonly phase: Phase; readonly passed: boolean; readonly status: number | null; readonly failure?: Failure }[];
}

/** Syntactic safeguards only; actual authorization always happens at the target Worker. */
export function parseSyntheticAcceptanceCredentials(value: unknown, nowMs = Date.now()): SyntheticAcceptanceCredentials {
  if (!object(value) || !keys(value, ["mode", "tenant", "source", "tokens"]) || value.mode !== "synthetic" || !label(value.tenant) ||
      !["educateos", "playtrek", "hall-monitor"].includes(value.source as string) || !object(value.tokens) ||
      !keys(value.tokens, ["ready", "evaluate", "replay", "receipt"]) || !Number.isFinite(nowMs)) throw new Error("invalid synthetic credentials");
  const seen = new Set<string>(), now = Math.floor(nowMs / 1000);
  for (const [phase, token] of Object.entries(value.tokens)) {
    if (typeof token !== "string" || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid service token");
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")); } catch { throw new Error("invalid service token"); }
    if (!object(claims) || claims.tenant !== value.tenant || !label(claims.jti) || typeof claims.iss !== "string" || claims.iss.length === 0 ||
        typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + 300 ||
        typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp) throw new Error("unsuitable service token claims");
    const identity = JSON.stringify([claims.iss, claims.jti]);
    if (seen.has(identity)) throw new Error("service tokens must have distinct replay identities");
    seen.add(identity);
    const scope = Array.isArray(claims.scope) ? claims.scope : typeof claims.scope === "string" ? claims.scope.split(/\s+/) : [];
    if (phase !== "ready" && !scope.includes(phase === "receipt" ? "receipts:read" : "evaluate")) throw new Error("service token lacks required scope");
  }
  return { mode: "synthetic", tenant: value.tenant, source: value.source as SyntheticAcceptanceCredentials["source"],
    tokens: { ...value.tokens } as SyntheticAcceptanceCredentials["tokens"] };
}

export function validateAcceptanceTarget(target: AcceptanceTarget): AcceptanceTarget {
  const u = new URL(target.url);
  if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash ||
      !/^[a-f0-9]{40}$/.test(target.expectedCommit) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.deploymentId)) throw new Error("invalid acceptance target");
  return { url: u.origin, expectedCommit: target.expectedCommit, deploymentId: target.deploymentId };
}

class Refused extends Error { constructor(readonly failure: Failure) { super(failure); } }
async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Refused("response");
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE) throw new Refused("response");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const all = new Uint8Array(length); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all)); } catch { throw new Refused("response"); }
}

/** Executes five bounded HTTP requests, with one privately supplied fresh JWT per authenticated call. */
export async function runSyntheticEvaluatorAcceptance(options: {
  readonly target: AcceptanceTarget; readonly credentials: unknown;
  readonly fetch?: typeof fetch; readonly now?: () => number;
}): Promise<AcceptanceEvidence> {
  const target = validateAcceptanceTarget(options.target), now = options.now ?? Date.now;
  const credentials = parseSyntheticAcceptanceCredentials(options.credentials, now());
  const send = options.fetch ?? fetch;
  const checks: { phase: Phase; passed: boolean; status: number | null; failure?: Failure }[] = [];
  const id = randomUUID().replaceAll("-", ""), sentinel = `SYNTHETIC-ACCEPTANCE-${randomUUID()}`;
  const input = EvaluationRequest.parse({ schemaVersion: "1.0", requestId: `req_smoke_${id}`, idempotencyKey: `idem_smoke_${id}`,
    source: { product: credentials.source, tenantId: credentials.tenant, surface: "synthetic.smoke" },
    policy: { profileId: "student-9-12", revision: "builtin-1" }, context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_synthetic_smoke" },
    evaluationKind: "interaction.input", content: { type: "text", text: `${sentinel} What is two plus two?` } });
  let result: EvaluationResult | undefined;
  for (const phase of PHASES) {
    let status: number | null = null;
    try {
      const authenticated = phase !== "health";
      const tokenPhase = phase === "readiness" ? "ready" : phase === "evaluation" ? "evaluate" : phase;
      const token = authenticated ? credentials.tokens[tokenPhase as keyof SyntheticAcceptanceCredentials["tokens"]] : undefined;
      const path = phase === "health" ? "/v1/health" : phase === "readiness" ? "/v1/ready" : phase === "receipt" ? `/v1/receipts/${encodeURIComponent(result!.evaluationId)}` : "/v1/evaluations";
      const post = phase === "evaluation" || phase === "replay";
      const response = await send(new URL(path, target.url), { method: post ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json", "user-agent": "hall-monitor-synthetic-acceptance/1", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(post ? { "content-type": "application/json" } : {}) }, ...(post ? { body: JSON.stringify(input) } : {}) });
      status = response.status;
      if (status !== 200) { await response.body?.cancel(); throw new Refused("status"); }
      if (response.headers.get("x-hm-revision") !== target.expectedCommit) { await response.body?.cancel(); throw new Refused("revision"); }
      if (response.headers.get("x-hm-telemetry-posture") !== "unbound-disabled") { await response.body?.cancel(); throw new Refused("collection-enabled"); }
      const body = await boundedJson(response);
      if (JSON.stringify(body).includes(sentinel)) throw new Refused("content-reflected");
      switch (phase) {
        case "health": if (!object(body) || body.status !== "ok") throw new Refused("response"); break;
        case "readiness": {
          if (!object(body) || body.ready !== true || !object(body.checks)) throw new Refused("response");
          const readiness = body.checks;
          if (!keys(readiness, READY_CHECKS) || !READY_CHECKS.every((k) => readiness[k] === true)) throw new Refused("response");
          break;
        }
        case "evaluation": {
          const parsed = EvaluationResult.safeParse(body);
          if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.decision !== "allow" || parsed.data.uncertain ||
              parsed.data.degraded !== undefined || parsed.data.shadow !== undefined || parsed.data.policyRevision !== input.policy.revision ||
              parsed.data.receipt === null || parsed.data.receipt.attempts.length === 0 || parsed.data.receipt.tenantId !== credentials.tenant ||
              parsed.data.receipt.product !== credentials.source || parsed.data.receipt.logicalRequestId !== input.requestId ||
              parsed.data.receipt.costCenterId !== input.context.costCenterId ||
              response.headers.get("idempotent-replayed") === "true") throw new Refused("response");
          result = parsed.data; break;
        }
        case "replay": {
          const parsed = EvaluationResult.safeParse(body);
          if (!parsed.success || response.headers.get("idempotent-replayed") !== "true" || JSON.stringify(parsed.data) !== JSON.stringify(result)) throw new Refused("response");
          break;
        }
        case "receipt": {
          const parsed = ReceiptRecord.safeParse(body);
          if (!parsed.success || parsed.data.evaluationId !== result!.evaluationId || parsed.data.requestId !== input.requestId ||
              parsed.data.tenantId !== credentials.tenant || Date.parse(parsed.data.expiresAt) <= now() ||
              Date.parse(parsed.data.recordedAt) >= Date.parse(parsed.data.expiresAt) ||
              JSON.stringify(parsed.data.receipt) !== JSON.stringify(result!.receipt)) throw new Refused("response");
          break;
        }
      }
      checks.push({ phase, passed: true, status });
    } catch (error) {
      checks.push({ phase, passed: false, status, failure: error instanceof Refused ? error.failure : "request-failed" });
      break; // No token retry and no dependent call after a failed gate.
    }
  }
  return { schemaVersion: 1, mode: "synthetic", target, deploymentMetadata: "operator-supplied-verify-in-forgegraph",
    checkedAt: new Date(now()).toISOString(), passed: checks.length === PHASES.length && checks.every((c) => c.passed), productionEnrollmentApproved: false, checks };
}
