import { CLEF_QUESTIONS } from "@gmacko/hall-monitor-clef";

/** Marker that makes the fake classifier report harassment. Synthetic text only. */
export const HARASSMENT_MARKER = "SYNTHETIC-HARASSMENT-MARKER";

/**
 * A fake Workers AI binding answering in Clef's real response shape:
 * `{ model, answers: { [id]: { type: "noul", noul } }, usage: { input_tokens, output_tokens } }`.
 */
export const fakeAi = {
  calls: [] as { model: string; input: unknown; options: unknown }[],
  failing: false,
  async run(model: string, input: unknown, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input, options });
    if (this.failing) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    const text = String((input as { state?: { text?: unknown } }).state?.text ?? "");
    const answers = Object.fromEntries(
      CLEF_QUESTIONS.map((question) => [question.id, { type: "noul", noul: question.id === "harassment" && text.includes(HARASSMENT_MARKER) ? 0.97 : 0.02 }]),
    );
    return { model: model.slice(model.lastIndexOf("/") + 1), answers, usage: { input_tokens: 640, output_tokens: 12 } };
  },
  reset(): void {
    this.calls = [];
    this.failing = false;
  },
};
