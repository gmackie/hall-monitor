// The receiver under test: the real handler and the real aggregate store with only the clock and
// an injected commit failure exposed through the store's documented seams. Nothing here ships.
import worker, { type TelemetryEnv } from "../src/index.ts";
import { TelemetryAggregateStore as RealStore } from "../src/store.ts";
import { controls } from "./controls.ts";

export class TelemetryAggregateStore extends RealStore {
  protected override now(): number {
    return Date.now() + controls.clockOffsetMs;
  }
  protected override afterIngestWrites(): void {
    if (controls.failIngest) throw new Error("injected commit failure");
  }
}

export default worker satisfies ExportedHandler<TelemetryEnv>;
