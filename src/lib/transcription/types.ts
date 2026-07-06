export type TranscriptWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isFiller: boolean;
  deleted: boolean;
};

export type TranscriptSegmentResult = {
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
};

export type TranscriptionResult = {
  language: string;
  segments: TranscriptSegmentResult[];
};

export interface TranscriptionProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  transcribe(params: { audioPath: string; language?: string }): Promise<TranscriptionResult>;
}

export class TranscriptionProviderUnavailableError extends Error {}
