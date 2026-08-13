import { ClaudeAnalysisProvider } from "./claude-provider";
import { HeuristicAnalysisProvider } from "./heuristic-provider";
import { env } from "../env";
import { AnalysisProviderUnavailableError, type AnalysisProvider } from "./types";

export type AnalysisProviderSelectionReason =
  | "claude_available"
  | "development_no_api_key"
  | "test_no_api_key"
  | "production_emergency_override";

export type AnalysisProviderSelection = {
  provider: AnalysisProvider;
  providerKind: "claude" | "heuristic";
  selectionReason: AnalysisProviderSelectionReason;
  emergencyOverride: boolean;
};

/** Selects an analysis provider and makes every fallback reason explicit. */
export async function getAnalysisProvider(): Promise<AnalysisProviderSelection> {
  const claude = new ClaudeAnalysisProvider();
  if (await claude.isAvailable()) {
    return {
      provider: claude,
      providerKind: "claude",
      selectionReason: "claude_available",
      emergencyOverride: false,
    };
  }

  if (process.env.NODE_ENV === "production" && !env.ANALYSIS_ALLOW_HEURISTIC) {
    throw new AnalysisProviderUnavailableError(
      "ANTHROPIC_API_KEY is not configured and production heuristic analysis is disabled.",
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
