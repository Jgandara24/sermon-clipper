import { ClaudeAnalysisProvider, ClaudeStageAdapter } from "./claude-provider";
import { GeminiStageAdapter } from "./gemini-provider";
import { HeuristicAnalysisProvider } from "./heuristic-provider";
import { RoutedAnalysisProvider } from "./routed-provider";
import { env } from "../env";
import { AnalysisProviderUnavailableError, type AnalysisProvider } from "./types";
import type { ResolvedAnalysisRouting } from "./routing-store";

export type AnalysisProviderSelectionReason =
  | "claude_available"
  | "master_policy"
  | "development_no_api_key"
  | "test_no_api_key"
  | "production_emergency_override";

export type AnalysisProviderSelection = {
  provider: AnalysisProvider;
  providerKind: "claude" | "google" | "mixed" | "heuristic";
  selectionReason: AnalysisProviderSelectionReason;
  emergencyOverride: boolean;
};

/** Selects an analysis provider and makes every fallback reason explicit. */
export async function getAnalysisProvider(
  resolved?: ResolvedAnalysisRouting,
): Promise<AnalysisProviderSelection> {
  if (resolved) {
    if (
      resolved.routing.classification.provider === "heuristic" &&
      resolved.routing.scoring.provider === "heuristic"
    ) {
      return {
        provider: new HeuristicAnalysisProvider(),
        providerKind: "heuristic",
        selectionReason: "master_policy",
        emergencyOverride: false,
      };
    }
    if (
      resolved.routing.classification.provider === "heuristic" ||
      resolved.routing.scoring.provider === "heuristic" ||
      resolved.routing.classification.provider === "openai" ||
      resolved.routing.scoring.provider === "openai"
    ) {
      throw new AnalysisProviderUnavailableError(
        `Analysis route ${resolved.routing.classification.provider}/${resolved.routing.scoring.provider} is not installed.`,
      );
    }
  }

  const provider: AnalysisProvider = resolved
    ? new RoutedAnalysisProvider(
        resolved.routing.classification.provider === "anthropic"
          ? new ClaudeStageAdapter(
              resolved.routing.classification.model,
              resolved.prices.classification,
            )
          : new GeminiStageAdapter(
              resolved.routing.classification.model,
              resolved.prices.classification,
            ),
        resolved.routing.scoring.provider === "anthropic"
          ? new ClaudeStageAdapter(resolved.routing.scoring.model, resolved.prices.scoring)
          : new GeminiStageAdapter(resolved.routing.scoring.model, resolved.prices.scoring),
        `${resolved.routing.classification.provider}:${resolved.routing.classification.model} -> ${resolved.routing.scoring.provider}:${resolved.routing.scoring.model}`,
      )
    : new ClaudeAnalysisProvider();
  if (await provider.isAvailable()) {
    const providerKind = !resolved
      ? "claude"
      : resolved.routing.classification.provider !== resolved.routing.scoring.provider
        ? "mixed"
        : resolved.routing.classification.provider === "google"
          ? "google"
          : "claude";
    return {
      provider,
      providerKind,
      selectionReason: resolved ? "master_policy" : "claude_available",
      emergencyOverride: false,
    };
  }

  if (process.env.NODE_ENV === "production" && !env.ANALYSIS_ALLOW_HEURISTIC) {
    throw new AnalysisProviderUnavailableError(
      "The selected analysis provider key is not configured and production heuristic analysis is disabled.",
    );
  }

  const productionOverride = process.env.NODE_ENV === "production";
  return {
    provider: new HeuristicAnalysisProvider(),
    providerKind: "heuristic",
    selectionReason: productionOverride
      ? "production_emergency_override"
      : process.env.NODE_ENV === "test"
        ? "test_no_api_key"
        : "development_no_api_key",
    emergencyOverride: productionOverride,
  };
}

export * from "./types";
