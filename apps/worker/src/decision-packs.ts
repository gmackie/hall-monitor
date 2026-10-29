import { CLEF_CLASSIFIER_VERSION, type ClefQuestion } from "@gmacko/hall-monitor-clef";
import { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, CLEF_MODEL, CLOUDFLARE_WORKERS_AI } from "@gmacko/hall-monitor-costing";
import { BASELINE_DECISION_PACK, BASELINE_DECISION_PACK_PIN, createDecisionRegistry } from "@gmacko/hall-monitor-noul-registry";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

interface DecisionQuestions {
  readonly text: readonly ClefQuestion[];
  readonly image: readonly ClefQuestion[];
}

let registry: ReturnType<typeof createDecisionRegistry> | undefined;
let cached: { key: string | undefined; value: Promise<DecisionQuestions | undefined> } | undefined;

/** Server-owned pin only. A malformed explicit setting never falls back to the built-in pin. */
export function loadDecisionQuestions(env: Env): Promise<DecisionQuestions | undefined> {
  if (cached !== undefined && cached.key === env.HM_DECISION_PACK) return cached.value;
  const value = resolve(env.HM_DECISION_PACK);
  cached = { key: env.HM_DECISION_PACK, value };
  return value;
}

async function resolve(setting: string | undefined): Promise<DecisionQuestions | undefined> {
  try {
    const pin: unknown = setting === undefined ? BASELINE_DECISION_PACK_PIN : JSON.parse(setting);
    const installed = await (registry ??= createDecisionRegistry([{ pack: BASELINE_DECISION_PACK, pin: BASELINE_DECISION_PACK_PIN }]));
    const selection = {
      classifierVersion: CLEF_CLASSIFIER_VERSION,
      providerId: CLOUDFLARE_WORKERS_AI,
      modelIds: [CLEF_FLASH_MODEL, CLEF_MODEL],
      evaluationKind: "interaction.input" as const,
      contextFields: ["audience", "evaluationKind"],
    };
    const text = installed.questions(pin, { ...selection, modality: "text" });
    const image = installed.questions(pin, { ...selection, modality: "image" });
    // This deployment serves every existing kind. Do not admit a narrower pack and then reuse
    // its questions for an unsupported kind or a context field the request contract omits.
    const allKinds = EvaluationKind.options.every((evaluationKind) =>
      ["text", "image"].every((modality) => installed.questions(pin, {
        ...selection, evaluationKind, modality: modality as "text" | "image",
      }) !== undefined));
    if (text !== undefined && image !== undefined && allKinds) return Object.freeze({ text, image });
  } catch {
    // Never log the pin, pack contents or parsing errors.
  }
  log("error", "config.invalid", { variable: "HM_DECISION_PACK" });
  return undefined;
}
