import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getTranscriptionProvider,
  resolveTranscriptionProviderPolicy,
  TranscriptionProviderConfigError,
} from "@/lib/transcription";

async function readableModelPath(): Promise<{ modelPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transcription-provider-"));
  const modelPath = path.join(dir, "model.bin");
  await writeFile(modelPath, "model");
  return { modelPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Provider selection is an explicit deployment policy, never inferred from which credentials
// happen to be present. A key that appears in the environment for an unrelated reason — a
// boundary-detection sample, a staging copy, a rotation in progress — must not silently
// redirect church sermon audio to a paid external provider.
describe("resolveTranscriptionProviderPolicy", () => {
  it("names the configured primary and fallback", () => {
    const policy = resolveTranscriptionProviderPolicy({
      TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
      TRANSCRIPTION_FALLBACK_PROVIDER: "whisper_cpp",
    });

    expect(policy.primary).toBe("scribe");
    expect(policy.fallback).toBe("whisper_cpp");
  });

  it("defaults to whisper.cpp with no fallback, so a deploy never activates Scribe by accident", () => {
    const policy = resolveTranscriptionProviderPolicy({});

    expect(policy.primary).toBe("whisper_cpp");
    expect(policy.fallback).toBeNull();
  });

  it("ignores a present ELEVENLABS_API_KEY when the policy does not name Scribe", () => {
    const policy = resolveTranscriptionProviderPolicy({ ELEVENLABS_API_KEY: "present" });

    expect(policy.primary).toBe("whisper_cpp");
    expect(policy.fallback).toBeNull();
  });

  it("rejects an unknown provider name instead of guessing one", () => {
    expect(() =>
      resolveTranscriptionProviderPolicy({ TRANSCRIPTION_PRIMARY_PROVIDER: "deepgram" }),
    ).toThrow(TranscriptionProviderConfigError);
  });

  it("rejects a fallback that repeats the primary", () => {
    expect(() =>
      resolveTranscriptionProviderPolicy({
        TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
        TRANSCRIPTION_FALLBACK_PROVIDER: "scribe",
      }),
    ).toThrow(TranscriptionProviderConfigError);
  });

  it("treats an explicit \"none\" fallback as no fallback", () => {
    const policy = resolveTranscriptionProviderPolicy({
      TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
      TRANSCRIPTION_FALLBACK_PROVIDER: "none",
    });

    expect(policy.fallback).toBeNull();
  });
});

describe("getTranscriptionProvider", () => {
  it("serves the configured primary", async () => {
    const provider = await getTranscriptionProvider({
      TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(provider.name).toBe("elevenlabs_scribe_v2");
  });

  it("does not serve Scribe when the policy names whisper.cpp, key present or not", async () => {
    const { modelPath, cleanup } = await readableModelPath();
    try {
      const provider = await getTranscriptionProvider({
        ELEVENLABS_API_KEY: "test-key",
        WHISPER_MODEL_PATH: modelPath,
      });

      expect(provider.name).toBe("whisper_cpp");
    } finally {
      await cleanup();
    }
  });

  it("serves the named fallback when the primary has no credentials", async () => {
    const { modelPath, cleanup } = await readableModelPath();
    try {
      const provider = await getTranscriptionProvider({
        TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
        TRANSCRIPTION_FALLBACK_PROVIDER: "whisper_cpp",
        WHISPER_MODEL_PATH: modelPath,
      });

      expect(provider.name).toBe("whisper_cpp");
    } finally {
      await cleanup();
    }
  });

  it("refuses rather than faking a transcript when neither provider can serve", async () => {
    const provider = await getTranscriptionProvider({
      TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
      TRANSCRIPTION_FALLBACK_PROVIDER: "whisper_cpp",
    });

    expect(provider.name).toBe("unavailable");
  });
});
