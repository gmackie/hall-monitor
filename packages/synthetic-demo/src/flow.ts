import { OpaqueId, type EvaluationResult } from "@gmacko/hall-monitor-contracts";

export interface SyntheticDraft {
  readonly mode: "synthetic";
  readonly draft: string;
  readonly requestId: string;
  readonly phase: "unreviewed" | "screened" | "unavailable";
  readonly decision: EvaluationResult["decision"] | null;
  readonly published: boolean;
  readonly reportRequested: boolean;
  readonly helpVisible: true;
}
export function createSyntheticDraft(draft: string, requestId: string): SyntheticDraft {
  if (!OpaqueId.safeParse(requestId).success) throw new Error("invalid synthetic request id");
  return Object.freeze({ mode: "synthetic", draft, requestId, phase: "unreviewed", decision: null, published: false, reportRequested: false, helpVisible: true });
}
export function screenSyntheticDraft(state: SyntheticDraft, result: EvaluationResult | null): SyntheticDraft {
  if (result !== null && result.requestId !== state.requestId) return state;
  return Object.freeze({ ...state, published: false, phase: result === null ? "unavailable" : "screened", decision: result?.decision ?? null });
}
export function editSyntheticDraft(state: SyntheticDraft, replacement: string, newRequestId: string): SyntheticDraft {
  if (newRequestId === state.requestId) throw new Error("edited draft needs a new synthetic request id");
  return createSyntheticDraft(replacement, newRequestId);
}
/** Local choice simulation only: no composer, publishing endpoint or report recipient is installed. */
export function chooseSyntheticDraft(state: SyntheticDraft, choice: "continue" | "report" | "help"): SyntheticDraft {
  return Object.freeze({ ...state, reportRequested: state.reportRequested || choice === "report",
    published: choice === "continue" && state.phase === "screened" && state.decision === "allow" });
}
