import { ScribeTranscriptionProvider } from "./scribe-provider";
import { UnavailableTranscriptionProvider } from "./unavailable-provider";
import { WhisperCppTranscriptionProvider } from "./whisper-cpp-provider";
import {
  resolveTranscriptionProviderPolicy,
  type TranscriptionProviderName,
  type TranscriptionProviderPolicy,
} from "./policy";
import type { TranscriptionProvider } from "./types";

/** Constructs the named provider. Construction never checks credentials — selection is policy. */
export function transcriptionProviderByName(
  name: TranscriptionProviderName,
  env: Record<string, string | undefined> = process.env,
): TranscriptionProvider {
  return name === "scribe"
    ? new ScribeTranscriptionProvider({ apiKey: env.ELEVENLABS_API_KEY })
    : new WhisperCppTranscriptionProvider(env.WHISPER_CPP_BINARY, env.WHISPER_MODEL_PATH);
}

export type SelectedTranscriptionProviders = {
  policy: TranscriptionProviderPolicy;
  primary: TranscriptionProvider;
  fallback: TranscriptionProvider | null;
};

/**
 * Resolves the configured provider pair. Both are built whatever their credentials look like;
 * a provider that cannot serve reports that through isAvailable() at job time, where the
 * failure is visible, rather than by quietly not being chosen.
 */
export function resolveTranscriptionProviders(
  env: Record<string, string | undefined> = process.env,
): SelectedTranscriptionProviders {
  const policy = resolveTranscriptionProviderPolicy(env);
  return {
    policy,
    primary: transcriptionProviderByName(policy.primary, env),
    fallback: policy.fallback ? transcriptionProviderByName(policy.fallback, env) : null,
  };
}

/**
 * The single provider that should serve this job: the configured primary when it can, else the
 * configured fallback. Returns the honest "unavailable" provider when neither can serve, so the
 * job fails with TRANSCRIBE_PROVIDER_UNAVAILABLE instead of faking a transcript.
 */
export async function getTranscriptionProvider(
  env: Record<string, string | undefined> = process.env,
): Promise<TranscriptionProvider> {
  const { primary, fallback } = resolveTranscriptionProviders(env);
  if (await primary.isAvailable()) return primary;
  if (fallback && (await fallback.isAvailable())) return fallback;
  return new UnavailableTranscriptionProvider();
}

export * from "./types";
export {
  resolveTranscriptionProviderPolicy,
  transcriptionProviderRequirement,
  TranscriptionProviderConfigError,
  TRANSCRIPTION_PROVIDER_NAMES,
  type TranscriptionProviderName,
  type TranscriptionProviderPolicy,
} from "./policy";
export {
  normalizeScribeKeyterms,
  parseScribeResponse,
  readScribeKeyterms,
  scribePricePerMinuteUsd,
  ScribeTranscriptionProvider,
} from "./scribe-provider";
export { WhisperCppTranscriptionProvider, parseWhisperCppOutput } from "./whisper-cpp-provider";
