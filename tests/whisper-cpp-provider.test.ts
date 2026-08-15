import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWhisperCppOutput,
  WhisperCppTranscriptionProvider,
} from "@/lib/transcription/whisper-cpp-provider";

// Trimmed down real output captured from `whisper-cli -ojf` against a TTS-generated fixture.
const REAL_FIXTURE = JSON.stringify({
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 3200 },
      text: " This is a test sermon about peace.",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.998424 },
        { text: " This", offsets: { from: 20, to: 250 }, p: 0.817444 },
        { text: " is", offsets: { from: 250, to: 370 }, p: 0.998731 },
        { text: " a", offsets: { from: 370, to: 420 }, p: 0.991548 },
        { text: " test", offsets: { from: 420, to: 650 }, p: 0.911857 },
        { text: " sermon", offsets: { from: 820, to: 1060 }, p: 0.977193 },
        { text: " about", offsets: { from: 1060, to: 1370 }, p: 0.997815 },
        { text: " peace", offsets: { from: 1370, to: 1640 }, p: 0.96626 },
        { text: ".", offsets: { from: 3200, to: 3200 }, p: 0.812514 },
        { text: "[_TT_160]", offsets: { from: 3200, to: 3200 }, p: 0.167179 },
      ],
    },
  ],
});

describe("WhisperCppTranscriptionProvider telemetry", () => {
  it("measures successful local compute without a paid API price", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "whisper-telemetry-"));
    const modelPath = path.join(dir, "model.bin");
    await writeFile(modelPath, "model");
    const fakeExec = async (_binary: string, args: string[]) => {
      const outputBase = args[args.indexOf("-of") + 1];
      await writeFile(`${outputBase}.json`, REAL_FIXTURE);
      return { stdout: "", stderr: "" };
    };

    try {
      const provider = new WhisperCppTranscriptionProvider("whisper-cli", modelPath, fakeExec);
      await provider.transcribe({ audioPath: path.join(dir, "audio.wav"), language: "en" });
      expect(provider.lastTelemetry).toMatchObject({ outcome: "succeeded" });
      expect(provider.lastTelemetry?.wallTimeMs).toBeGreaterThanOrEqual(0);
      expect(provider.lastTelemetry?.cpuTimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseWhisperCppOutput", () => {
  it("extracts language, segment text, and per-word timing", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);

    expect(result.language).toBe("en");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("This is a test sermon about peace.");
    expect(result.segments[0].startMs).toBe(0);
    expect(result.segments[0].endMs).toBe(3200);
  });

  it("filters out bracketed special tokens and merges punctuation onto its word", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    const words = result.segments[0].words.map((w) => w.word);

    expect(words).not.toContain("[_BEG_]");
    expect(words).not.toContain("[_TT_160]");
    expect(words).toEqual(["This", "is", "a", "test", "sermon", "about", "peace."]);
  });

  it("does not stretch a word to a punctuation token stamped after a long silence", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    const last = result.segments[0].words[result.segments[0].words.length - 1];

    // "." is stamped at the segment end (3200); "peace" spoke until 1640. The text attaches,
    // the dead air does not — otherwise the caption highlight stalls on "peace." for 1.5s.
    expect(last.word).toBe("peace.");
    expect(last.endMs).toBe(1640);
  });

  it("preserves per-word timing and confidence", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    const first = result.segments[0].words[0];

    expect(first).toMatchObject({ word: "This", startMs: 20, endMs: 250 });
    expect(first.confidence).toBeCloseTo(0.817444, 5);
  });

  it("defaults new words to not filler and not deleted", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    expect(result.segments[0].words.every((w) => w.isFiller === false && w.deleted === false)).toBe(
      true,
    );
  });
});
