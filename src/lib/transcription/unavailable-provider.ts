import { TranscriptionProviderUnavailableError, type TranscriptionProvider } from "./types";

/** Honest fallback when no real provider is configured — fails clearly instead of faking output. */
export class UnavailableTranscriptionProvider implements TranscriptionProvider {
  readonly name = "unavailable";

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async transcribe(): Promise<never> {
    throw new TranscriptionProviderUnavailableError(
      "No transcription provider is configured in this environment.",
    );
  }
}
