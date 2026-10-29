import { clefQuestionsFromDefinitions, type ClefQuestion } from "@gmacko/hall-monitor-clef";
import type { EvaluationKind } from "@gmacko/hall-monitor-contracts";
import { type DecisionModality, type DecisionPack, DecisionPackPin, parseDecisionPack } from "./definition.ts";

export class DecisionRegistryError extends Error {
  override readonly name = "DecisionRegistryError";
  constructor() { super("invalid decision-pack installation"); }
}

/** JSON object keys are canonical; ordered arrays (including wire order) remain ordered. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Domain-separated SHA-256 over a strictly parsed pack. No remote downloads or signing keys. */
export async function decisionPackDigest(input: unknown): Promise<string> {
  const pack = parseDecisionPack(input);
  if (pack === undefined) throw new DecisionRegistryError();
  const bytes = new TextEncoder().encode(`hall-monitor/decision-pack/v1\n${canonical(pack)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface DecisionSelection {
  readonly classifierVersion: string;
  readonly providerId: string;
  /** All models that could receive this evaluation, including escalation. */
  readonly modelIds: readonly string[];
  readonly modality: DecisionModality;
  readonly evaluationKind: EvaluationKind;
  readonly contextFields: readonly string[];
}

export interface DecisionRegistry {
  /** A pin is mandatory; no latest-version, partial-pack or permissive fallback. */
  questions(pin: unknown, selection: DecisionSelection): readonly ClefQuestion[] | undefined;
}

/** Validate every installed pack before exposing an immutable, closed-over registry. */
export async function createDecisionRegistry(entries: readonly { readonly pack: unknown; readonly pin: unknown }[]): Promise<DecisionRegistry> {
  const installed = new Map<string, { pack: DecisionPack; pin: DecisionPackPin }>();
  for (const entry of entries) {
    const pack = parseDecisionPack(entry.pack);
    const parsedPin = DecisionPackPin.safeParse(entry.pin);
    if (pack === undefined || !parsedPin.success) throw new DecisionRegistryError();
    const pin = Object.freeze(parsedPin.data);
    const key = `${pin.id}@${pin.version}`;
    if (pack.manifest.id !== pin.id || pack.manifest.version !== pin.version || installed.has(key) ||
        await decisionPackDigest(pack) !== pin.digest) throw new DecisionRegistryError();
    installed.set(key, { pack, pin });
  }
  return Object.freeze({
    questions(input: unknown, selection: DecisionSelection): readonly ClefQuestion[] | undefined {
      const parsed = DecisionPackPin.safeParse(input);
      if (!parsed.success) return undefined;
      const { id, version, digest } = parsed.data;
      const found = installed.get(`${id}@${version}`);
      if (found === undefined || found.pin.digest !== digest) return undefined;
      const { manifest, definitions } = found.pack;
      const provider = manifest.providers.find((p) => p.id === selection.providerId);
      if (manifest.classifierVersion !== selection.classifierVersion || !manifest.modalities.includes(selection.modality) ||
          provider === undefined || selection.modelIds.length === 0 || selection.modelIds.some((m) => !provider.modelIds.includes(m)) ||
          definitions.some((d) => !d.evaluationKinds.includes(selection.evaluationKind) ||
            d.requiredContext.some((f) => !selection.contextFields.includes(f)))) return undefined;
      return clefQuestionsFromDefinitions(definitions, selection.modality);
    },
  });
}
