// The receiver under test: the real handler and the real aggregate store with only the clock and
// an injected commit failure exposed through the store's documented seams. Nothing here ships.
import worker, { type TelemetryEnv } from "../src/index.ts";
import { TelemetryAggregateStore as RealStore } from "../src/store.ts";
import { controls } from "./controls.ts";

export class TelemetryAggregateStore extends RealStore {
  protected override now(): number {
    return Date.now() + controls.clockOffsetMs;
  }
  /**
   * Tests age the object's clock, which can make an expiry "already due" by the real clock. A real
   * alarm firing mid-test would race the runner's storage teardown, so the request is recorded and a
   * far-future alarm is armed instead; tests run the alarm by hand with runDurableObjectAlarm.
   */
  protected override async armAlarm(at: number): Promise<void> {
    controls.armed.push(at);
    await super.armAlarm(Math.max(at, Date.now() + 7 * 24 * 60 * 60 * 1000));
  }
  protected override afterIngestWrites(): void {
    if (controls.failIngest) throw new Error("injected commit failure");
  }
}

export default worker satisfies ExportedHandler<TelemetryEnv>;
