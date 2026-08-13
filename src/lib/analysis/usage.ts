import type { ProcessingCostFactInput, ProcessingCostStage } from "@/lib/cost/types";

/**
 * Provider spend telemetry for AI analysis. Token usage is captured per model call in the
 * ClaudeAnalysisProvider and estimated in USD here. ANALYZE records each call through the shared
 * processing-cost contract; /app/settings/operations rolls up those facts. Estimates use list
 * prices — the invoice from Anthropic is the source of truth.
 */

export type AnalysisModelCall = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  wallTimeMs?: number;
  outcome?: "succeeded" | "failed";
};

export type AnalysisUsage = {
  calls: AnalysisModelCall[];
  totalInputTokens: number;
  totalOutputTokens: number;
  /** USD, list-price estimate. Calls on models missing from the pricing table contribute 0. */
  estimatedCostUsd: number;
  /** Models we could not price — non-empty means estimatedCostUsd undercounts. */
  unpricedModels: string[];
};

// USD per million tokens (list prices; cache writes bill at 1.25x input, reads at 0.1x input).
const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
};

const MTOK = 1_000_000;

export function estimateCallCostUsd(call: AnalysisModelCall): number | null {
  const pricing = MODEL_PRICING_PER_MTOK[call.model];
  if (!pricing) {
    return null;
  }
  return (
    (call.inputTokens * pricing.input +
      call.cacheCreationInputTokens * pricing.input * 1.25 +
      call.cacheReadInputTokens * pricing.input * 0.1 +
      call.outputTokens * pricing.output) /
    MTOK
  );
}

/** Converts one model call to the shared P0 cost-fact contract without recording it. */
export function analysisCallCostFact(
  call: AnalysisModelCall,
  stage: Extract<ProcessingCostStage, "analysis_classification" | "analysis_scoring">,
  providerProvenance: string,
): ProcessingCostFactInput {
  const cacheState =
    call.cacheReadInputTokens > 0
      ? "hit"
      : call.cacheCreationInputTokens > 0
        ? "partial"
        : "miss";
  return {
    stage,
    quantity: 1,
    unit: "call",
    unitCostUsd: estimateCallCostUsd(call),
    provider: "anthropic",
    model: call.model,
    providerProvenance,
    cacheState,
    wallTimeMs: call.wallTimeMs ?? null,
    details: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
    },
  };
}

export function buildAnalysisUsage(calls: AnalysisModelCall[]): AnalysisUsage {
  let estimatedCostUsd = 0;
  const unpricedModels = new Set<string>();
  for (const call of calls) {
    const cost = estimateCallCostUsd(call);
    if (cost === null) {
      unpricedModels.add(call.model);
    } else {
      estimatedCostUsd += cost;
    }
  }
  return {
    calls,
    totalInputTokens: calls.reduce(
      (sum, c) => sum + c.inputTokens + c.cacheCreationInputTokens + c.cacheReadInputTokens,
      0,
    ),
    totalOutputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    estimatedCostUsd,
    unpricedModels: [...unpricedModels],
  };
}
