import { UnavailableTranscriptionProvider } from "./unavailable-provider";
import { WhisperCppTranscriptionProvider } from "./whisper-cpp-provider";
import type { TranscriptionProvider } from "./types";

/** Auto-detects a real local provider; falls back to an honest "unavailable" failure. */
export async function getTranscriptionProvider(): Promise<TranscriptionProvider> {
  const whisperCpp = new WhisperCppTranscriptionProvider();
  if (await whisperCpp.isAvailable()) {
    return whisperCpp;
  }
  return new UnavailableTranscriptionProvider();
}

export * from "./types";
export { WhisperCppTranscriptionProvider, parseWhisperCppOutput } from "./whisper-cpp-provider";
