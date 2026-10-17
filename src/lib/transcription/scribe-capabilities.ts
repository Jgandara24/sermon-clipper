import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { transcriptCapabilitiesSchema, type TranscriptCapabilities } from "./provenance";
import type { TranscriptionProviderEvidence } from "./types";

/** Describes persisted display fields without mistaking compatibility defaults for provider evidence. */
export function scribeTranscriptCapabilities(evidence: TranscriptionProviderEvidence): TranscriptCapabilities {
  const inputSha256 = rangeEvidenceSha256(evidence);
  const words = evidence.entries.filter(entry => entry.type === "word");
  if (!words.length) throw new Error("TRANSCRIPT_CAPABILITIES_WORDS_REQUIRED");
  const native = { status: "native" as const, provider: evidence.provider, modelVersion: evidence.modelVersion };
  const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
  return transcriptCapabilitiesSchema.parse({
    wordTimestamps: { status: "derived", algorithmVersion: "scribe-display-timestamps-v1", inputSha256 },
    wordConfidence: words.every(word => word.logProbability !== null)
      ? { status: "derived", algorithmVersion: "scribe-exp-logprob-clamped-v1", inputSha256 }
      : unavailable("Scribe omitted some word log probabilities. Display defaults are not measured confidence."),
    tokenConfidence: unavailable("Scribe word evidence does not contain subword token confidence."),
    speakerLabels: words.every(word => word.speakerId !== null && word.speakerId.length > 0)
      ? native : unavailable("Scribe omitted some word speaker labels. Available labels remain in provider evidence."),
    audioEvents: native,
    silences: unavailable("No acoustic silence evidence is attached to this transcript."),
    sentences: unavailable("Display segments are not persisted sentence boundaries."),
    paragraphs: unavailable("No paragraph derivation is attached to this transcript."),
  });
}
