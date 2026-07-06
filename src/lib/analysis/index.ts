import { ClaudeAnalysisProvider } from "./claude-provider";
import { HeuristicAnalysisProvider } from "./heuristic-provider";
import type { AnalysisProvider } from "./types";

/** Auto-detects a real Claude API key; falls back to the deterministic heuristic scorer. */
export async function getAnalysisProvider(): Promise<AnalysisProvider> {
  const claude = new ClaudeAnalysisProvider();
  if (await claude.isAvailable()) {
    return claude;
  }
  return new HeuristicAnalysisProvider();
}

export * from "./types";
