import type { AnalysisModelCall } from "../usage";

export type MessageCall = {
  stage: "analysis_classification" | "analysis_scoring";
  payload: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};

/** Capability contract. Stage 3 supplies mocks only; existing live providers do not advertise this capability. */
export interface CompleteMessageAdapter {
  measureInputTokens(payload: string): number;
  invoke(call: MessageCall): Promise<{ output: unknown; usage: AnalysisModelCall; truncated: boolean }>;
}
