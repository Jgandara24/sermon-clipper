import type { AnalysisUsage } from "./usage";

export type Subscore = {
  score: number;
  letter: string;
  note: string;
};

export type ScoredCandidate = {
  startMs: number;
  endMs: number;
  text: string;
  title: string;
  hookText: string;
  summary: string;
  excerpt: string;
  total: number;
  subscores: Record<string, Subscore>;
  modelVersion: string;
  scriptureReferences?: Array<{
    detectedText: string;
    normalized: string;
    book: string;
    chapterStart: number;
    verseStart: number | null;
    chapterEnd: number | null;
    verseEnd: number | null;
    confidence: number;
  }>;
};

export type AnalysisCandidate = {
  startMs: number;
  endMs: number;
  text: string;
};

export type AnalysisContext = {
  fullText: string;
  genre: string;
};

export interface AnalysisProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  scoreCandidates(
    candidates: AnalysisCandidate[],
    context: AnalysisContext,
  ): Promise<ScoredCandidate[]>;
  /**
   * Provider token usage for the most recent scoreCandidates call, for spend telemetry.
   * Undefined/null for providers that spend nothing (heuristic).
   */
  lastUsage?: AnalysisUsage | null;
}

export class AnalysisProviderUnavailableError extends Error {}
