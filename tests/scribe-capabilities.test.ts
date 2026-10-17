import { describe, expect, it } from "vitest";
import { parseScribeResponse } from "@/lib/transcription/scribe-provider";
import { offsetTranscriptionResult } from "@/lib/transcription/submitted-range";
import { scribeTranscriptCapabilities } from "@/lib/transcription/scribe-capabilities";

const result = () => parseScribeResponse({ language_code: "en", text: "Hello.", words: [
  { type: "word", text: "Hello.", start: 0, end: 1, speaker_id: "speaker", logprob: -0.5 },
] });

describe("Scribe field capability provenance", () => {
  it("distinguishes normalized display timing and confidence from native provider labels", () => {
    const capabilities = scribeTranscriptCapabilities(result().providerEvidence!);
    expect(capabilities.wordTimestamps).toMatchObject({ status: "derived", algorithmVersion: "scribe-display-timestamps-v1" });
    expect(capabilities.wordConfidence).toMatchObject({ status: "derived", algorithmVersion: "scribe-exp-logprob-clamped-v1" });
    expect(capabilities.speakerLabels).toEqual({ status: "native", provider: "elevenlabs", modelVersion: "scribe_v2" });
    expect(capabilities.audioEvents.status).toBe("native");
    for (const key of ["tokenConfidence", "silences", "sentences", "paragraphs"] as const) {
      expect(capabilities[key].status).toBe("unavailable");
    }
  });
  it("does not report legacy default confidence as provider confidence", () => {
    const transcript = parseScribeResponse({ language_code: "en", text: "Hello.", words: [
      { type: "word", text: "Hello.", start: 0, end: 1 },
    ] });
    expect(transcript.segments[0].words[0].confidence).toBe(1);
    const capabilities = scribeTranscriptCapabilities(transcript.providerEvidence!);
    expect(capabilities.wordConfidence.status).toBe("unavailable");
    expect(capabilities.speakerLabels.status).toBe("unavailable");
  });
  it("binds derived fields to the source offset and provider evidence", () => {
    const transcript = result();
    const original = scribeTranscriptCapabilities(transcript.providerEvidence!);
    const mapped = scribeTranscriptCapabilities(offsetTranscriptionResult(transcript, 60000).providerEvidence!);
    expect(mapped.wordTimestamps).not.toEqual(original.wordTimestamps);
    expect(scribeTranscriptCapabilities(transcript.providerEvidence!)).toEqual(original);
  });
});
