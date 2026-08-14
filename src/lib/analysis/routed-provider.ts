import type { AnalysisStageAdapter } from "./stage-adapter";
import { buildAnalysisUsage, type AnalysisModelCall, type AnalysisUsage } from "./usage";
import type {
  AnalysisCandidate,
  AnalysisContext,
  AnalysisProvider,
  ScoredCandidate,
} from "./types";

/** Composes independently selected Stage A and Stage B adapters. */
export class RoutedAnalysisProvider implements AnalysisProvider {
  lastUsage: AnalysisUsage | null = null;

  constructor(
    readonly classification: AnalysisStageAdapter,
    readonly scoring: AnalysisStageAdapter,
    readonly name: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    const [classification, scoring] = await Promise.all([
      this.classification.isAvailable(),
      this.scoring.isAvailable(),
    ]);
    return classification && scoring;
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    context: AnalysisContext,
  ): Promise<ScoredCandidate[]> {
    this.lastUsage = null;
    const calls: AnalysisModelCall[] = [];
    try {
      const classification = await this.classification.classifyCandidates(candidates);
      calls.push(classification.call);
      this.lastUsage = buildAnalysisUsage(calls);
      if (classification.kept.length === 0) return [];
      const scoring = await this.scoring.scoreCandidates(candidates, classification.kept, context);
      calls.push(scoring.call);
      this.lastUsage = buildAnalysisUsage(calls);
      return scoring.scored;
    } catch (error) {
      for (const adapter of [this.classification, this.scoring]) {
        if (adapter.lastCall && !calls.includes(adapter.lastCall)) calls.push(adapter.lastCall);
      }
      this.lastUsage = buildAnalysisUsage(calls);
      throw error;
    }
  }
}
