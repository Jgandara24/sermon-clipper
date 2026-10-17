import { z } from "zod";
import { buildAnalysisDerivatives } from "@/lib/media/analysis-derivatives";
import { extractSermonAudio } from "@/lib/media/sermon-audio";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { fileIdentity } from "@/lib/storage/file-identity";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { transcriptProvenanceSchema } from "./provenance";
import { scribeTranscriptCapabilities } from "./scribe-capabilities";
import { offsetTranscriptionResult } from "./submitted-range";
import type { TranscriptionProvider } from "./types";

type Analysis = Awaited<ReturnType<typeof buildAnalysisDerivatives>>["analysis"];
type SermonAudio = Awaited<ReturnType<typeof extractSermonAudio>>;

/** Internal local-phase consumer. The caller must hold its source lease through this awaited call.
 * Exactly one provider invocation; no retry, secondary provider, or larger-audio fallback.
 */
export async function transcribeVerifiedSermonAudio(input: {
  sourceVideoId: string; sourceSha256: string; analysis: Analysis; audio: SermonAudio;
  provider: TranscriptionProvider; language?: string;
}) {
  z.string().uuid().parse(input.sourceVideoId);
  sha256Schema.parse(input.sourceSha256);
  const { analysis, audio, provider } = input;
  const proof = analysis.mappingEvidence, trim = audio.evidence;
  if (provider.name !== "elevenlabs_scribe_v2") throw new Error("SERMON_TRANSCRIPTION_SCRIBE_REQUIRED");
  if (rangeEvidenceSha256(proof) !== analysis.mappingEvidenceSha256 ||
    rangeEvidenceSha256(trim) !== audio.evidenceSha256 || proof.sourceSha256 !== input.sourceSha256 ||
    proof.analysisSha256 !== analysis.sha256 || trim.inputSha256 !== analysis.sha256 ||
    trim.output.sha256 !== audio.sha256 || trim.output.byteCount !== audio.byteCount ||
    trim.inputSourceInterval.startMs !== proof.sourceInterval.startMs ||
    trim.inputSourceInterval.endMs !== proof.sourceInterval.endMs ||
    trim.corridor.sourceInterval.startMs < proof.sourceInterval.startMs ||
    trim.corridor.sourceInterval.endMs > proof.sourceInterval.endMs ||
    trim.sourceOffsetMs !== trim.corridor.sourceInterval.startMs ||
    trim.durationMs !== trim.corridor.sourceInterval.endMs - trim.sourceOffsetMs ||
    trim.sampleCount !== trim.durationMs * 16) throw new Error("SERMON_TRANSCRIPTION_MAPPING_INVALID");
  const before = await fileIdentity(audio.path);
  if (before.sha256 !== audio.sha256 || before.byteCount !== audio.byteCount) throw new Error("SERMON_TRANSCRIPTION_AUDIO_CHANGED");
  if (!await provider.isAvailable()) throw new Error("SERMON_TRANSCRIPTION_PROVIDER_UNAVAILABLE");
  const returned = await provider.transcribe({ audioPath: audio.path, language: input.language, keyterms: [] });
  const after = await fileIdentity(audio.path);
  if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("SERMON_TRANSCRIPTION_AUDIO_CHANGED");
  const evidence = returned.providerEvidence;
  if (!evidence || evidence.provider !== "elevenlabs" || evidence.modelVersion !== "scribe_v2" || evidence.sourceOffsetMs !== 0) {
    throw new Error("SERMON_TRANSCRIPTION_PROVIDER_EVIDENCE_REQUIRED");
  }
  for (const entry of evidence.entries) {
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.start < 0 || entry.end < entry.start ||
      entry.end * 1000 > trim.durationMs) throw new Error("SERMON_TRANSCRIPTION_PROVIDER_OUTSIDE_CORRIDOR");
  }
  for (const segment of returned.segments) {
    for (const word of segment.words) {
      if (!Number.isSafeInteger(word.startMs) || !Number.isSafeInteger(word.endMs) || word.startMs < 0 ||
        word.endMs < word.startMs || word.endMs > trim.durationMs) throw new Error("SERMON_TRANSCRIPTION_DISPLAY_OUTSIDE_CORRIDOR");
    }
  }
  const result = offsetTranscriptionResult(returned, trim.sourceOffsetMs);
  const capabilities = scribeTranscriptCapabilities(result.providerEvidence!);
  const provenance = transcriptProvenanceSchema.parse({ sourceVideoId: input.sourceVideoId,
    sourceSha256: input.sourceSha256, submittedAudioSha256: audio.sha256, submittedDurationMs: trim.durationMs,
    sourceInterval: trim.corridor.sourceInterval, sourceOffsetMs: trim.sourceOffsetMs,
    provider: "elevenlabs", modelVersion: "scribe_v2",
    requestIdentity: { status: "unavailable", reason: "The provider adapter did not capture a request identifier." }, capabilities });
  return { result, capabilities, provenance, submission: { artifactSha256: audio.sha256, byteCount: audio.byteCount,
    analysisMappingEvidenceSha256: analysis.mappingEvidenceSha256, trimEvidenceSha256: audio.evidenceSha256,
    detectorVersion: trim.corridor.detectorVersion, corridorConfidence: trim.corridor.confidence,
    requestCount: 1, keyterms: [] as string[], noVerbatim: false } };
}
