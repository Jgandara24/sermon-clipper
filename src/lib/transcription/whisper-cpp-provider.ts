import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import { env } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import { mergeTokensIntoWords } from "./token-merge";
import {
  TranscriptionProviderUnavailableError,
  type TranscriptionProvider,
  type TranscriptionResult,
  type TranscriptionTelemetry,
} from "./types";

type ExecFile = typeof execFileWithTimeout;

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

/** Pure parser for `whisper-cli -ojf` (output-json-full) output. */
export function parseWhisperCppOutput(raw: string): TranscriptionResult {
  const parsed: WhisperCppOutput = JSON.parse(raw);
  const language = parsed.result?.language ?? "en";

  const segments = (parsed.transcription ?? []).map((segment) => ({
    startMs: segment.offsets.from,
    endMs: segment.offsets.to,
    text: segment.text.trim(),
    // Raw, untrimmed token text goes to the merger — the leading space IS the word boundary.
    words: mergeTokensIntoWords(
      (segment.tokens ?? []).map((token) => ({
        text: token.text,
        startMs: token.offsets.from,
        endMs: token.offsets.to,
        p: token.p,
      })),
    ),
  }));

  return { language, segments };
}

/** Real, self-hosted transcription via whisper.cpp — no paid provider, no network call. */
export class WhisperCppTranscriptionProvider implements TranscriptionProvider {
  readonly name = "whisper_cpp";

  private readonly binaryPath: string;
  private readonly modelPath: string | undefined;
  private readonly execFile: ExecFile;
  lastTelemetry: TranscriptionTelemetry | null = null;

  constructor(binaryPath?: string, modelPath?: string, execFile: ExecFile = execFileWithTimeout) {
    this.binaryPath = binaryPath ?? env.WHISPER_CPP_BINARY ?? "whisper-cli";
    this.modelPath = modelPath ?? env.WHISPER_MODEL_PATH;
    this.execFile = execFile;
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
    const runtime = startRuntimeMeasurement();
    this.lastTelemetry = null;

    try {
      await this.execFile(
        this.binaryPath,
        ["-m", this.modelPath as string, "-f", audioPath, "-l", language ?? "auto", "-ojf", "-of", outputBase, "-np"],
        // CPU ASR of a 3 h sermon can legitimately take over an hour on a small worker.
        { timeoutMs: envTimeoutMs("WHISPER_TIMEOUT_MS", 5_400_000) },
      );

      const raw = await readFile(`${outputBase}.json`, "utf-8");
      const result = parseWhisperCppOutput(raw);
      this.lastTelemetry = { ...finishRuntimeMeasurement(runtime), outcome: "succeeded" };
      return result;
    } catch (error) {
      this.lastTelemetry = { ...finishRuntimeMeasurement(runtime), outcome: "failed" };
      throw error;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
