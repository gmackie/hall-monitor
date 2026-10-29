// The Worker under test: the real handler with the fake AI binding injected. Nothing here ships.
import type { TelemetryProducerRetentionV2, TelemetryProducerTenantsV2 } from "@gmacko/hall-monitor-telemetry-contracts";
import type { TelemetryBinding } from "@gmacko/hall-monitor-telemetry-sink";
import worker, { type Env } from "../src/index.ts";
import { IdempotencyStore as RealIdempotencyStore } from "../src/store.ts";
import { binding, currentGrants, currentRetention, probe } from "./collector.ts";
import { fakeAi } from "./fake-ai.ts";

export { TokenReplayGuard } from "../src/index.ts";
// The reconciliation drill connects both real stores inside this test-only Worker.
export { TelemetryAggregateStore } from "../../telemetry-worker/test/entry.ts";

/**
 * The real store with only its documented seams pointed at the test controls: which tenants are
 * enrolled for v2, which collector receives deliveries, how long an attempt may take, and an
 * injected commit failure. All queueing, alarm, backoff and gap logic is the production code.
 */
export class IdempotencyStore extends RealIdempotencyStore {
  protected override async producerGrants(): Promise<TelemetryProducerTenantsV2 | null> {
    return currentGrants();
  }
  protected override retentionPolicies(): TelemetryProducerRetentionV2 | null {
    return currentRetention();
  }
  protected override collector(): TelemetryBinding | undefined {
    return binding;
  }
  protected override firstAttemptDelayMs(): number {
    return probe.firstAttemptDelayMs;
  }
  protected override deliveryTimeoutMs(): number {
    return probe.timeoutMs;
  }
  protected override afterCompletionWrites(): void {
    if (probe.failCompletion) throw new Error("injected commit failure");
  }
}

export default {
  fetch(request, env) {
    return worker.fetch(request, { ...env, AI: fakeAi });
  },
} satisfies ExportedHandler<Env>;
