import type { ClefTransport, ClefTransportResult } from "../src/index.ts";
import { CLEF_QUESTIONS } from "../src/index.ts";

/** A scripted reply: a result, an error to throw, or "hang" to wait until aborted. */
export type FakeReply = ClefTransportResult | Error | "hang";

/** A transport that replays scripted replies and records which models were called. */
export class FakeTransport implements ClefTransport {
  readonly calls: { model: string; input: unknown }[] = [];

  /** Creates a transport that answers calls with `replies` in order. */
  constructor(private readonly replies: FakeReply[]) {}

  async run(model: string, input: unknown, { signal }: { signal: AbortSignal }): Promise<ClefTransportResult> {
    this.calls.push({ model, input });
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("unexpected call");
    if (reply === "hang") {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

/** A well-formed Clef answer with every category at `base` except the overrides. */
export function scored(overrides: Record<string, number> = {}, base = 0.02, inputTokens: number | null = 602): ClefTransportResult {
  return {
    output: { answers: CLEF_QUESTIONS.map((question) => ({ id: question.id, score: overrides[question.id] ?? base })) },
    ...(inputTokens === null ? {} : { usage: { inputTokens } }),
    gatewayLogId: "log_fake",
  };
}
