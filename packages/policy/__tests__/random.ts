import type { Finding } from "@gmacko/hall-monitor-contracts";
import { FindingCategory, Severity } from "@gmacko/hall-monitor-contracts";

/** A small deterministic PRNG (mulberry32) so generated cases are reproducible from a seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks one element uniformly. */
export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

const REASON_CODES = ["privacy.email", "academic_integrity.direct_answer_request", "safety.weapon_instructions", "self_harm.disclosure", "quality.low"];

/** A random valid finding. */
export function randomFinding(random: () => number): Finding {
  return {
    evaluatorId: pick(random, ["pii", "harm", "clef"]),
    evaluatorVersion: "1.0.0",
    category: pick(random, FindingCategory.options),
    reasonCode: pick(random, REASON_CODES),
    severity: pick(random, Severity.options),
  };
}

/** Returns a shuffled copy. */
export function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
