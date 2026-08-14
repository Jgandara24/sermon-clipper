import type { AnalysisModelCall } from "./usage";
import type { AnalysisCandidate, AnalysisContext, ScoredCandidate } from "./types";

export type ClassificationStageOutput = { kept: number[]; call: AnalysisModelCall };
export type ScoringStageOutput = { scored: ScoredCandidate[]; call: AnalysisModelCall };

export interface AnalysisStageAdapter {
  readonly provider: AnalysisModelCall["provider"];
  readonly lastCall?: AnalysisModelCall | null;
  isAvailable(): Promise<boolean>;
  classifyCandidates(candidates: AnalysisCandidate[]): Promise<ClassificationStageOutput>;
  scoreCandidates(
    candidates: AnalysisCandidate[],
    kept: number[],
    context: AnalysisContext,
  ): Promise<ScoringStageOutput>;
}
