export type TranscriptWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isFiller: boolean;
  deleted: boolean;
  speakerLabel?: string;
};

export type TranscriptSegmentResult = {
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
  speakerLabel?: string;
};

export type TranscriptionResult = {
  language: string;
  segments: TranscriptSegmentResult[];
};

export type TranscriptionTelemetry = {
  wallTimeMs: number;
  cpuTimeMs: number;
  outcome: "succeeded" | "failed";
};

export interface TranscriptionProvider {
  readonly name: string;
  readonly lastTelemetry?: TranscriptionTelemetry | null;
  isAvailable(): Promise<boolean>;
  transcribe(params: {
    audioPath: string;
    language?: string;
    keyterms?: string[];
  }): Promise<TranscriptionResult>;
}

export class TranscriptionProviderUnavailableError extends Error {}
