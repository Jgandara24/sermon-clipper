import { ScribeTranscriptionProvider } from "./scribe-provider";
import { UnavailableTranscriptionProvider } from "./unavailable-provider";
import { WhisperCppTranscriptionProvider } from "./whisper-cpp-provider";
import type { TranscriptionProvider } from "./types";

/** Selects quality-first Scribe when configured, then the local whisper.cpp fallback. */
export async function getTranscriptionProvider(): Promise<TranscriptionProvider> {
  const scribe = new ScribeTranscriptionProvider();
  if (await scribe.isAvailable()) {
    return scribe;
  }
  const whisperCpp = new WhisperCppTranscriptionProvider();
  if (await whisperCpp.isAvailable()) {
    return whisperCpp;
  }
  return new UnavailableTranscriptionProvider();
}

export * from "./types";
export {
  normalizeScribeKeyterms,
  parseScribeResponse,
  readScribeKeyterms,
  scribePricePerMinuteUsd,
  ScribeTranscriptionProvider,
} from "./scribe-provider";
export { WhisperCppTranscriptionProvider, parseWhisperCppOutput } from "./whisper-cpp-provider";
