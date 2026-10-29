import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";
import { Enrollment, Observations, type PrivacyAttestation, type Route, observationsAllow } from "./policy.ts";

export interface PrivacyInspector {
  /** Must read settings only. Never transfer inference input or repair provider configuration. */
  inspect(route: Route): Promise<Omit<Observations, "modelRetention">>;
}

const ApprovalRecord = z.strictObject({
  enrollment: Enrollment,
  verifierRef: OpaqueId,
  evidenceExpiresAt: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  providerRetention: z.enum(["approved", "denied", "unverified"]),
});

export interface PreflightReport {
  readonly schemaVersion: "1.0";
  readonly result: "verified" | "unverified" | "denied";
  readonly reason: "matched" | "approval_invalid" | "approval_inactive" | "settings_unverified" | "settings_denied";
  readonly attestation: PrivacyAttestation | null;
}

export const UNKNOWN_OBSERVATIONS: Omit<Observations, "modelRetention"> = Object.freeze({
  workerObservability: "unverified", accountLogpush: "unverified", gatewayLogs: "unverified",
  gatewayCache: "unverified", aiBinding: "unverified", route: "unverified",
});

/** The operator supplies references to human decisions; the tool cannot create those decisions. */
export async function runPrivacyPreflight(input: unknown, inspector: PrivacyInspector, now: number): Promise<PreflightReport> {
  const parsed = ApprovalRecord.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return { schemaVersion: "1.0", result: "unverified", reason: "approval_invalid", attestation: null };
  const { enrollment: e, verifierRef, evidenceExpiresAt, providerRetention } = parsed.data;
  const expiresAt = Math.min(evidenceExpiresAt, e.approvedUntil);
  if (e.revoked || now < e.approvedFrom || now >= expiresAt) return { schemaVersion: "1.0", result: "denied", reason: "approval_inactive", attestation: null };
  let inspected = UNKNOWN_OBSERVATIONS;
  try { inspected = await inspector.inspect(e.route); } catch { /* permission, network and parse failures remain unknown */ }
  const validated = Observations.safeParse({ ...inspected, modelRetention: providerRetention });
  const observations: Observations = validated.success ? validated.data : { ...UNKNOWN_OBSERVATIONS, modelRetention: providerRetention };
  const denied = Object.values(observations).some((v) => v === "enabled" || v === "mismatched" || v === "denied");
  const result = denied ? "denied" : observationsAllow(e.route, observations) ? "verified" : "unverified";
  return {
    schemaVersion: "1.0", result,
    reason: result === "verified" ? "matched" : result === "denied" ? "settings_denied" : "settings_unverified",
    attestation: {
      schemaVersion: "1.0", institutionId: e.institutionId, policyRevision: e.policyRevision,
      approvalRef: e.approvalRef, agreementRef: e.agreementRef, verifierRef, route: e.route,
      dataClasses: e.dataClasses, ageEligibility: e.ageEligibility, checkedAt: now, expiresAt, observations, result,
    },
  };
}

const ApiResponse = z.object({ success: z.literal(true), result: z.unknown() });
const Binding = z.object({ type: z.string(), name: z.string(), text: z.string().optional() });
const WorkerSettings = z.object({
  bindings: z.array(Binding), observability: z.object({ enabled: z.boolean(),
    logs: z.object({ enabled: z.boolean() }).optional(), traces: z.object({ enabled: z.boolean() }).optional(),
  }).optional(), logpush: z.boolean().optional(),
  tail_consumers: z.array(z.unknown()).optional(),
});
const Jobs = z.array(z.object({ enabled: z.boolean() }));
const Gateway = z.object({ collect_logs: z.boolean(), cache_ttl: z.number().nullable(), logpush: z.boolean().optional() });

/** Current Cloudflare REST settings shape. Anything absent or newly incompatible remains unknown. */
export function cloudflarePrivacyInspector(token: string, fetchImpl: typeof fetch = globalThis.fetch): PrivacyInspector {
  async function read(path: string): Promise<unknown> {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const parsed = ApiResponse.safeParse(await response.json());
      return parsed.success ? parsed.data.result : undefined;
    } catch { return undefined; }
  }
  return {
    async inspect(route) {
      const account = `/accounts/${route.accountId}`;
      const [workerRaw, jobsRaw, gatewayRaw] = await Promise.all([
        read(`${account}/workers/scripts/${encodeURIComponent(route.workerName)}/settings`),
        read(`${account}/logpush/jobs`),
        route.gatewayId === null ? undefined : read(`${account}/ai-gateway/gateways/${encodeURIComponent(route.gatewayId)}`),
      ]);
      const worker = WorkerSettings.safeParse(workerRaw);
      const jobs = Jobs.safeParse(jobsRaw);
      const gateway = Gateway.safeParse(gatewayRaw);
      const observations = { ...UNKNOWN_OBSERVATIONS };
      if (jobs.success) observations.accountLogpush = jobs.data.some((j) => j.enabled) ? "enabled" : "disabled";
      if (worker.success) {
        const w = worker.data;
        observations.workerObservability = w.observability?.enabled === true || w.observability?.logs?.enabled === true ||
          w.observability?.traces?.enabled === true || (w.tail_consumers?.length ?? 0) > 0 ? "enabled"
          : w.observability?.enabled === false && w.tail_consumers !== undefined ? "disabled" : "unverified";
        if (w.logpush === true) observations.accountLogpush = "enabled";
        // An omitted flag is not proof that Worker Logpush is disabled.
        else if (w.logpush === undefined && observations.accountLogpush !== "enabled") observations.accountLogpush = "unverified";
        observations.aiBinding = w.bindings.some((b) => b.name === "AI" && b.type === "ai") ? "matched" : "mismatched";
        const revision = w.bindings.find((b) => b.name === "FG_COMMIT_HASH");
        const gatewayBinding = w.bindings.find((b) => b.name === "HM_AI_GATEWAY_ID");
        const revisionMatched = revision?.type === "plain_text" && revision.text === route.sourceRevision;
        const gatewayMatched = route.kind === "direct" ? gatewayBinding === undefined
          : gatewayBinding?.type === "plain_text" && gatewayBinding.text === route.gatewayId;
        observations.route = !revisionMatched ? "mismatched" : gatewayMatched ? "matched"
          : gatewayBinding?.type === "secret_text" ? "unverified" : "mismatched";
      }
      if (route.kind === "direct") {
        observations.gatewayLogs = "not_applicable"; observations.gatewayCache = "not_applicable";
      } else if (gateway.success) {
        observations.gatewayLogs = gateway.data.collect_logs || gateway.data.logpush === true ? "enabled"
          : gateway.data.logpush === false ? "disabled" : "unverified";
        // null means unset/unknown, not a confirmed zero TTL.
        observations.gatewayCache = gateway.data.cache_ttl === 0 ? "disabled"
          : gateway.data.cache_ttl === null ? "unverified" : gateway.data.cache_ttl > 0 ? "enabled" : "unverified";
      }
      return observations;
    },
  };
}
