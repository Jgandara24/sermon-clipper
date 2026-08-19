/**
 * Which transcription provider serves production is a deployment policy, stated explicitly.
 *
 * It is deliberately NOT inferred from which credentials are present. A key can appear in an
 * environment for reasons that have nothing to do with captioning production sermons — a
 * boundary-detection sample, a staging copy, a rotation in progress — and none of those should
 * silently redirect a church's sermon audio to a paid external provider. Naming the provider
 * makes the switch an auditable act.
 */

export const TRANSCRIPTION_PROVIDER_NAMES = ["scribe", "whisper_cpp"] as const;

export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDER_NAMES)[number];

export type TranscriptionProviderPolicy = {
  primary: TranscriptionProviderName;
  /** Serves only when the primary cannot. Null means a primary outage fails the job. */
  fallback: TranscriptionProviderName | null;
};

export class TranscriptionProviderConfigError extends Error {}

type EnvLike = Record<string, string | undefined>;

/**
 * Scribe v2 is the primary provider in every environment, with whisper.cpp as the secondary.
 * The defaults match that policy so an environment that names nothing still gets the intended
 * one; naming it explicitly is still the documented practice, because a default is a decision
 * nobody had to read.
 *
 * whisper.cpp keeps a second, separate job: short local samples for the pre-Scribe
 * sermon-boundary pass. That role is unrelated to which provider captions production sermons.
 */
const DEFAULT_PRIMARY: TranscriptionProviderName = "scribe";
const DEFAULT_FALLBACK: TranscriptionProviderName = "whisper_cpp";

function parseName(
  raw: string | undefined,
  field: string,
  fallbackValue: TranscriptionProviderName | null,
  allowNone: boolean,
): TranscriptionProviderName | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallbackValue;
  if (allowNone && value === "none") return null;
  const match = TRANSCRIPTION_PROVIDER_NAMES.find((name) => name === value);
  if (!match) {
    const allowed = [...TRANSCRIPTION_PROVIDER_NAMES, ...(allowNone ? ["none"] : [])].join(", ");
    throw new TranscriptionProviderConfigError(
      `${field} must be one of: ${allowed}. Received: ${value}.`,
    );
  }
  return match;
}

export function resolveTranscriptionProviderPolicy(env: EnvLike): TranscriptionProviderPolicy {
  const primary = parseName(
    env.TRANSCRIPTION_PRIMARY_PROVIDER,
    "TRANSCRIPTION_PRIMARY_PROVIDER",
    DEFAULT_PRIMARY,
    false,
  );
  if (!primary) {
    throw new TranscriptionProviderConfigError("TRANSCRIPTION_PRIMARY_PROVIDER cannot be none.");
  }

  const fallback = parseName(
    env.TRANSCRIPTION_FALLBACK_PROVIDER,
    "TRANSCRIPTION_FALLBACK_PROVIDER",
    DEFAULT_FALLBACK === primary ? null : DEFAULT_FALLBACK,
    true,
  );
  if (fallback && fallback === primary) {
    throw new TranscriptionProviderConfigError(
      "TRANSCRIPTION_FALLBACK_PROVIDER must name a different provider than the primary.",
    );
  }

  return { primary, fallback };
}

/** The credential each provider needs, for readiness reporting. */
export function transcriptionProviderRequirement(name: TranscriptionProviderName): string {
  return name === "scribe" ? "ELEVENLABS_API_KEY" : "WHISPER_MODEL_PATH";
}
