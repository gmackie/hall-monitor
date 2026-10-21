import type { EvaluatorBundle, EvaluatorPlugin } from "@gmacko/hall-monitor-evaluators";

/** Stages whose latency the shadow report measures. */
export type Stage = "deterministic" | "classifier";

/**
 * Records when each stage of one evaluation started and finished. Evaluations run one at a time
 * under a recorder, so a stage's latency is the span from its first plugin's start to its last
 * plugin's end.
 */
export class StageRecorder {
  #spans = new Map<Stage, { start: number; end: number }>();

  /** Clears the spans before the next evaluation. */
  reset(): void {
    this.#spans.clear();
  }

  /** The measured duration of a stage in milliseconds, or undefined when it did not run. */
  duration(stage: Stage): number | undefined {
    const span = this.#spans.get(stage);
    return span === undefined ? undefined : span.end - span.start;
  }

  /** Wraps a plugin so its runs are recorded under `stage`. */
  wrap(stage: Stage, plugin: EvaluatorPlugin): EvaluatorPlugin {
    return {
      id: plugin.id,
      version: plugin.version,
      supportedKinds: plugin.supportedKinds,
      evaluate: async (request, context) => {
        const start = performance.now();
        try {
          return await plugin.evaluate(request, context);
        } finally {
          const end = performance.now();
          const span = this.#spans.get(stage);
          this.#spans.set(stage, { start: Math.min(span?.start ?? start, start), end: Math.max(span?.end ?? end, end) });
        }
      },
    };
  }

  /** Wraps every plugin of a bundle under the deterministic stage, keeping its id and revision. */
  wrapBundle(bundle: EvaluatorBundle): EvaluatorBundle {
    return { id: bundle.id, revision: bundle.revision, plugins: bundle.plugins.map((plugin) => this.wrap("deterministic", plugin)) };
  }
}

/** Latency summary of one stage, in milliseconds rounded to microseconds. */
export interface LatencyStats {
  readonly samples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** The nearest-rank percentile of `values` (`p` in 0-100), or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

/** p50, p95 and max of a stage's samples. */
export function summarizeLatency(values: readonly number[]): LatencyStats {
  const round = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);
  return {
    samples: values.length,
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    maxMs: round(values.length === 0 ? null : Math.max(...values)),
  };
}
