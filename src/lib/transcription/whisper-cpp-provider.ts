import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import {
  TranscriptionProviderUnavailableError,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "./types";

type WhisperCppToken = {
  text: string;
  offsets: { from: number; to: number };
  p: number;
};

type WhisperCppSegment = {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperCppToken[];
};

type WhisperCppOutput = {
  result?: { language?: string };
  transcription?: WhisperCppSegment[];
};

// whisper.cpp emits bracketed pseudo-tokens like [_BEG_], [_TT_160] alongside real words.
const SPECIAL_TOKEN_PATTERN = /^\[.*\]$/;

/** Pure parser for `whisper-cli -ojf` (output-json-full) output. */
export function parseWhisperCppOutput(raw: string): TranscriptionResult {
  const parsed: WhisperCppOutput = JSON.parse(raw);
  const language = parsed.result?.language ?? "en";

  const segments = (parsed.transcription ?? []).map((segment) => {
    const words = (segment.tokens ?? [])
      .map((token) => ({
        word: token.text.trim(),
        startMs: token.offsets.from,
        endMs: token.offsets.to,
        confidence: token.p,
        isFiller: false,
        deleted: false,
      }))
      .filter((word) => word.word.length > 0 && !SPECIAL_TOKEN_PATTERN.test(word.word));

    return {
      startMs: segment.offsets.from,
      endMs: segment.offsets.to,
      text: segment.text.trim(),
      words,
    };
  });

  return { language, segments };
}

/** Real, self-hosted transcription via whisper.cpp — no paid provider, no network call. */
export class WhisperCppTranscriptionProvider implements TranscriptionProvider {
  readonly name = "whisper_cpp";

  private readonly binaryPath: string;
  private readonly modelPath: string | undefined;

  constructor(binaryPath?: string, modelPath?: string) {
    this.binaryPath = binaryPath ?? env.WHISPER_CPP_BINARY ?? "whisper-cli";
    this.modelPath = modelPath ?? env.WHISPER_MODEL_PATH;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.modelPath) return false;
    try {
      await access(this.modelPath);
      return true;
    } catch {
      return false;
    }
  }

  async transcribe({
    audioPath,
    language,
  }: {
    audioPath: string;
    language?: string;
  }): Promise<TranscriptionResult> {
    if (!(await this.isAvailable())) {
      throw new TranscriptionProviderUnavailableError(
        "WHISPER_MODEL_PATH is not set or the model file is missing.",
      );
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sermon-clipper-whisper-"));
    const outputBase = path.join(tmpDir, "output");

    try {
      await execFileWithTimeout(
        this.binaryPath,
        ["-m", this.modelPath as string, "-f", audioPath, "-l", language ?? "auto", "-ojf", "-of", outputBase, "-np"],
        // CPU ASR of a 3 h sermon can legitimately take over an hour on a small worker.
        { timeoutMs: envTimeoutMs("WHISPER_TIMEOUT_MS", 5_400_000) },
      );

      const raw = await readFile(`${outputBase}.json`, "utf-8");
      return parseWhisperCppOutput(raw);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
