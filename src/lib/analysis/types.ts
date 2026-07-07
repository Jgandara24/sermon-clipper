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
}

export class AnalysisProviderUnavailableError extends Error {}
