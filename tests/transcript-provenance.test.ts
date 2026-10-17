import { describe, expect, it } from "vitest";
import { SRT_WORD_TIMING_ALGORITHM, srtTranscriptProvenance, transcriptCapabilitiesSchema, transcriptProvenanceSchema,
  userSuppliedTranscriptProvenanceSchema } from "@/lib/transcription/provenance";

const unavailable = { status: "unavailable", reason: "Not returned by this provider." };
const capabilities = {
  wordTimestamps: { status: "native", provider: "fixture", modelVersion: "fixture-v1" },
  wordConfidence: unavailable, tokenConfidence: unavailable, speakerLabels: unavailable,
  audioEvents: unavailable, silences: unavailable, sentences: unavailable, paragraphs: unavailable,
};
const provenance = {
  sourceVideoId: "00000000-0000-4000-8000-000000000001", sourceSha256: "a".repeat(64),
  submittedAudioSha256: "b".repeat(64), submittedDurationMs: 60000,
  sourceInterval: { startMs: 600000, endMs: 660000 }, sourceOffsetMs: 600000,
  provider: "fixture", modelVersion: "fixture-v1",
  requestIdentity: { status: "unavailable", reason: "Local process has no remote request ID." }, capabilities,
};

describe("transcript capability provenance", () => {
  it("records missing provider fields without claiming native support", () => {
    expect(transcriptProvenanceSchema.parse(provenance).capabilities.wordConfidence.status).toBe("unavailable");
  });
  it("keeps subword confidence separate from word confidence", () => {
    const parsed = transcriptCapabilitiesSchema.parse({ ...capabilities,
      tokenConfidence: { status: "native", provider: "fixture", modelVersion: "fixture-v1" } });
    expect(parsed.wordConfidence.status).toBe("unavailable");
    expect(parsed.tokenConfidence.status).toBe("native");
  });
  it("requires version and input identity for derived fields", () => {
    expect(transcriptCapabilitiesSchema.safeParse({ ...capabilities, sentences: { status: "derived" } }).success).toBe(false);
    expect(transcriptCapabilitiesSchema.safeParse({ ...capabilities,
      sentences: { status: "derived", algorithmVersion: "sentences-v1", inputSha256: "c".repeat(64) } }).success).toBe(true);
  });
  it.each([
    { sourceOffsetMs: 0 }, { submittedDurationMs: 59000 }, { submittedAudioSha256: "" },
    { requestIdentity: { status: "available", id: "" } }, { capabilities: {} },
    { modelVersion: " " },
  ])("rejects incomplete or inconsistent provenance: %j", change => {
    expect(transcriptProvenanceSchema.safeParse({ ...provenance, ...change }).success).toBe(false);
  });
});

describe("uploaded SRT provenance", () => {
  const input = { sourceVideoId: "11111111-1111-4111-8111-111111111111", srtSha256: "a".repeat(64), srtByteCount: 120, language: "en" };

  it("marks text and cue timing user-supplied and word times derived from the same file", () => {
    const provenance = srtTranscriptProvenance(input);
    expect(provenance.textAndCueTiming).toEqual({ status: "user-supplied", inputSha256: "a".repeat(64) });
    expect(provenance.capabilities.wordTimestamps).toEqual({ status: "derived",
      algorithmVersion: SRT_WORD_TIMING_ALGORITHM, inputSha256: "a".repeat(64) });
    expect(provenance.sourceOffsetMs).toBe(0);
  });

  it("never claims confidence, speakers, audio events, silences, or structure", () => {
    const { capabilities } = srtTranscriptProvenance(input);
    for (const field of ["wordConfidence", "tokenConfidence", "speakerLabels", "audioEvents", "silences", "sentences", "paragraphs"] as const) {
      expect(capabilities[field].status).toBe("unavailable");
    }
  });

  it("rejects word times attributed to a different input", () => {
    const provenance = srtTranscriptProvenance(input);
    expect(() => userSuppliedTranscriptProvenanceSchema.parse({ ...provenance, capabilities: { ...provenance.capabilities,
      wordTimestamps: { status: "derived", algorithmVersion: SRT_WORD_TIMING_ALGORITHM, inputSha256: "b".repeat(64) } } })).toThrow();
    expect(() => userSuppliedTranscriptProvenanceSchema.parse({ ...provenance, sourceOffsetMs: 5 })).toThrow();
  });
});
