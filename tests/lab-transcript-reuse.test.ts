import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LabTranscriptReuseError,
  readLabTranscriptReuse,
  reusedTranscription,
  withLabTranscriptReuse,
} from "@/lib/transcription/lab-transcript-reuse";

const URL = "https://www.youtube.com/watch?v=OuXJo09MZWk";
const FROM = "7f0c1c55-55a5-4a42-9b51-4f3cbd4f1c0e";
const words = [{ word: "Grace.", startMs: 1_000, endMs: 1_600, confidence: 0.98, isFiller: false, deleted: false }];
const evidence = {
  version: "scribe-response-evidence-v1",
  provider: "elevenlabs",
  modelVersion: "scribe_v2",
  timestampClock: "submitted-audio-seconds",
  sourceOffsetMs: 0,
  languageProbability: 0.99,
  entries: [],
};
const stored = {
  id: FROM,
  workspaceId: "lab-workspace",
  originUrl: URL,
  durationS: 5_116.8,
  transcript: {
    language: "en",
    provider: "elevenlabs_scribe_v2",
    providerEvidence: { ...evidence, displayCapabilities: { speakerLabels: true } },
    segments: [
      { startMs: 1_000, endMs: 1_600, text: "Grace.", speakerLabel: "speaker_0", words },
      { startMs: 2_000, endMs: 2_500, text: "Amen.", speakerLabel: null, words: [] },
    ],
  },
};
const target = { workspaceId: "lab-workspace", originUrl: URL, durationS: 5_116.76 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readLabTranscriptReuse", () => {
  it("reads the source to copy from when the lab switch is on", () => {
    vi.stubEnv("LAB_TRANSCRIPT_REUSE_ENABLED", "true");
    expect(readLabTranscriptReuse({ genre: "sermon", labTranscriptReuse: { fromSourceVideoId: FROM } })).toEqual({ fromSourceVideoId: FROM });
  });

  it("ignores the setting when the lab switch is off, and always in production", () => {
    const config = { labTranscriptReuse: { fromSourceVideoId: FROM } };
    expect(readLabTranscriptReuse(config)).toBeNull();
    vi.stubEnv("LAB_TRANSCRIPT_REUSE_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(readLabTranscriptReuse(config)).toBeNull();
  });

  it("ignores a missing or malformed setting", () => {
    vi.stubEnv("LAB_TRANSCRIPT_REUSE_ENABLED", "true");
    expect(readLabTranscriptReuse(null)).toBeNull();
    expect(readLabTranscriptReuse({ genre: "sermon" })).toBeNull();
    expect(readLabTranscriptReuse({ labTranscriptReuse: { fromSourceVideoId: 42 } })).toBeNull();
    expect(readLabTranscriptReuse({ labTranscriptReuse: { fromSourceVideoId: "not-a-uuid" } })).toBeNull();
  });
});

describe("reusedTranscription", () => {
  it("copies the stored transcript as the provider returned it", () => {
    const { result, provider } = reusedTranscription(target, stored);
    expect(provider).toBe("elevenlabs_scribe_v2");
    expect(result.language).toBe("en");
    // The stored evidence carries the display capabilities added when it was saved; the copy is the raw evidence.
    expect(result.providerEvidence).toEqual(evidence);
    expect(result.segments).toEqual([
      { startMs: 1_000, endMs: 1_600, text: "Grace.", speakerLabel: "speaker_0", words },
      { startMs: 2_000, endMs: 2_500, text: "Amen.", words: [] },
    ]);
  });

  it("refuses another video, another length, another workspace, or a source with no transcript", () => {
    expect(() => reusedTranscription({ ...target, originUrl: "https://www.youtube.com/watch?v=5cVMudHn2iw" }, stored)).toThrow(LabTranscriptReuseError);
    expect(() => reusedTranscription({ ...target, originUrl: null }, stored)).toThrow(/same video/);
    expect(() => reusedTranscription({ ...target, durationS: 5_118.2 }, stored)).toThrow(/1 second/);
    expect(() => reusedTranscription({ ...target, durationS: null }, stored)).toThrow(/1 second/);
    expect(() => reusedTranscription({ ...target, workspaceId: "church" }, stored)).toThrow(/workspace/);
    expect(() => reusedTranscription(target, { ...stored, transcript: null })).toThrow(/no transcript/);
    expect(() => reusedTranscription(target, { ...stored, transcript: { ...stored.transcript, segments: [] } })).toThrow(/no transcript/);
  });
});

describe("withLabTranscriptReuse (lab:run --reuse-transcript-from)", () => {
  const earlier = { projectId: "1g", sourceVideoId: FROM, originUrl: URL, hasTranscript: true };

  it("adds the source to copy from and keeps the rest of the project's config", () => {
    expect(withLabTranscriptReuse({ genre: "sermon", candidateLimit: 18 }, URL, earlier)).toEqual({
      genre: "sermon",
      candidateLimit: 18,
      labTranscriptReuse: { fromSourceVideoId: FROM, fromProjectId: "1g" },
    });
    expect(withLabTranscriptReuse(null, URL, earlier)).toEqual({ labTranscriptReuse: { fromSourceVideoId: FROM, fromProjectId: "1g" } });
  });

  it("refuses an earlier project of another video, or one with no transcript", () => {
    expect(() => withLabTranscriptReuse({}, "https://www.youtube.com/watch?v=5cVMudHn2iw", earlier)).toThrow(/same video/);
    expect(() => withLabTranscriptReuse({}, URL, { ...earlier, hasTranscript: false })).toThrow(/no transcript/);
    expect(() => withLabTranscriptReuse({}, URL, { ...earlier, sourceVideoId: null })).toThrow(/no transcript/);
  });
});
