import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTranscriptionProvider } from "@/lib/transcription";

const originalApiKey = process.env.ELEVENLABS_API_KEY;
const originalWhisperModel = process.env.WHISPER_MODEL_PATH;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalApiKey;
  if (originalWhisperModel === undefined) delete process.env.WHISPER_MODEL_PATH;
  else process.env.WHISPER_MODEL_PATH = originalWhisperModel;
});

describe("getTranscriptionProvider", () => {
  it("selects base Scribe v2 when ElevenLabs is configured", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    delete process.env.WHISPER_MODEL_PATH;

    const provider = await getTranscriptionProvider();

    expect(provider.name).toBe("elevenlabs_scribe_v2");
  });

  it("keeps whisper.cpp as the local fallback when Scribe is not configured", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "transcription-provider-"));
    const modelPath = path.join(dir, "model.bin");
    await writeFile(modelPath, "model");
    delete process.env.ELEVENLABS_API_KEY;
    process.env.WHISPER_MODEL_PATH = modelPath;

    try {
      const provider = await getTranscriptionProvider();
      expect(provider.name).toBe("whisper_cpp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
