// Test-only controllable collector and store seams (HM-20). Nothing here ships.
//
// The store runs inside a Durable Object, so a test cannot hand it a fake binding the way it can
// hand one to `handle()`. test/entry.ts instead exports a store subclass that reads these module-
// level controls; the test and the object run in the same isolate, so they share this state.
import { parseTelemetryProducerTenantsV2, type TelemetryProducerTenantsV2 } from "@gmacko/hall-monitor-telemetry-contracts";
import { sha256Hex } from "@gmacko/hall-monitor-telemetry-contracts";
import { signTelemetryAckV2, type TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";

export interface Attempt {
  readonly tenant: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly path: string;
  readonly body: string;
  readonly deliveryId: string;
  readonly digest: string;
  /** A fresh Request with the captured URL, headers and body, built in the caller's own context. */
  rebuild(): Request;
}

export const probe = {
  attempts: [] as Attempt[],
  /** Decides each attempt's response. Unset: the collector is unreachable. */
  handler: undefined as undefined | ((attempt: Attempt) => Response | Promise<Response>),
  timeoutMs: 5000,
  /**
   * Production sends a new row at once, from an alarm that fires by itself. Tests default to an
   * hour out so they drive the alarm deterministically instead of racing it (and the runner's
   * storage teardown); one test sets 0 to prove the immediate path.
   */
  firstAttemptDelayMs: 60 * 60 * 1000,
  /** Throws inside the completion transaction, after every write, to prove atomic rollback. */
  failCompletion: false,
  /** The v2 producer enrolment the store re-reads on each attempt; null models "v2 disabled". */
  grants: null as string | null,
  reset(): void {
    this.attempts = [];
    this.handler = undefined;
    this.timeoutMs = 5000;
    this.firstAttemptDelayMs = 60 * 60 * 1000;
    this.failCompletion = false;
    this.grants = null;
  },
};

export const binding: TelemetryBinding = {
  async fetch(request: Request): Promise<Response> {
    const body = await request.clone().text();
    const url = request.url;
    const headers = [...request.headers.entries()];
    const attempt: Attempt = {
      tenant: request.headers.get("x-hm-telemetry-tenant") ?? "",
      timestamp: request.headers.get("x-hm-telemetry-time") ?? "",
      signature: request.headers.get("x-hm-telemetry-signature") ?? "",
      path: new URL(request.url).pathname,
      body,
      deliveryId: (JSON.parse(body) as { deliveryId: string }).deliveryId,
      digest: await sha256Hex(body),
      rebuild: () => new Request(url, { method: request.method, headers, body }),
    };
    probe.attempts.push(attempt);
    if (probe.handler === undefined) throw new Error("collector unreachable");
    return probe.handler(attempt);
  },
};

/** The enrolment the store should currently see, parsed as production does. */
export function currentGrants(): TelemetryProducerTenantsV2 | null {
  return probe.grants === null ? null : parseTelemetryProducerTenantsV2(probe.grants);
}

/** A well-formed durable acknowledgment for `attempt`, MAC'd with `key`. */
export async function ack(attempt: Attempt, key: string, status: "committed" | "deduplicated" = "committed"): Promise<Response> {
  return Response.json(await signTelemetryAckV2(attempt.tenant, key, status, attempt.deliveryId, attempt.digest));
}
