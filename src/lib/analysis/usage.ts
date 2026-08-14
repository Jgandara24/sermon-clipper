import type { ProcessingCostFactInput, ProcessingCostStage } from "@/lib/cost/types";
import type { AnalysisModelPrice, AnalysisProviderKind } from "./routing";

/**
 * Provider spend telemetry for AI analysis. Token usage is captured per model call in the
 * ClaudeAnalysisProvider and estimated in USD here. ANALYZE records each call through the shared
 * processing-cost contract; /app/settings/operations rolls up those facts. Estimates use list
 * prices — the invoice from Anthropic is the source of truth.
 */

export type AnalysisModelCall = {
  stage: Extract<ProcessingCostStage, "analysis_classification" | "analysis_scoring">;
  provider: AnalysisProviderKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  wallTimeMs?: number;
  outcome?: "succeeded" | "failed";
  pricing: AnalysisModelPrice | null;
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

const MTOK = 1_000_000;

export function estimateCallCostUsd(call: AnalysisModelCall): number | null {
  const pricing = call.pricing;
  if (!pricing) {
    return null;
  }
  if (
    (call.cacheCreationInputTokens > 0 && pricing.cacheWritePerMillionUsd === null) ||
    (call.cacheReadInputTokens > 0 && pricing.cacheReadPerMillionUsd === null)
  ) {
    return null;
  }
  return (
    (call.inputTokens * pricing.inputPerMillionUsd +
      call.cacheCreationInputTokens *
        (pricing.cacheWritePerMillionUsd ?? 0) +
      call.cacheReadInputTokens *
        (pricing.cacheReadPerMillionUsd ?? 0) +
      call.outputTokens * pricing.outputPerMillionUsd) /
    MTOK
  );
}

/** Converts one model call to the shared P0 cost-fact contract without recording it. */
export function analysisCallCostFact(
  call: AnalysisModelCall,
  providerProvenance: string,
): ProcessingCostFactInput {
  const cacheState =
    call.cacheReadInputTokens > 0
      ? "hit"
      : call.cacheCreationInputTokens > 0
        ? "partial"
        : "miss";
  return {
    stage: call.stage,
    quantity: 1,
    unit: "call",
    unitCostUsd: estimateCallCostUsd(call),
    provider: call.provider,
    model: call.model,
    providerProvenance,
    cacheState,
    wallTimeMs: call.wallTimeMs ?? null,
    details: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      imageCount: 0,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
      pricingSourceUrl: call.pricing?.pricingSourceUrl ?? null,
      pricingEffectiveFrom: call.pricing?.effectiveFrom.toISOString() ?? null,
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
