import { openAsBlob } from "node:fs";
import path from "node:path";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import { env } from "@/lib/env";
import { envTimeoutMs } from "@/lib/media/child-process";
import {
  TranscriptionProviderUnavailableError,
  type TranscriptionProvider,
  type TranscriptionResult,
  type TranscriptionTelemetry,
} from "./types";

type ScribeWord = {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
  logprob?: number;
};

export type ScribeResponse = {
  language_code: string;
  language_probability?: number;
  text: string;
  words: ScribeWord[];
};

export type ScribeRequest = (params: {
  apiKey: string;
  audioPath: string;
  language?: string;
  keyterms: string[];
}) => Promise<ScribeResponse>;

export function normalizeScribeKeyterms(keyterms: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of keyterms) {
    const keyterm = raw.trim().replace(/\s+/g, " ");
    const identity = keyterm.toLocaleLowerCase("en-US");
    if (
      !keyterm ||
      keyterm.length >= 50 ||
      keyterm.split(" ").length > 5 ||
      /[<>{}[\]\\]/.test(keyterm) ||
      seen.has(identity)
    ) {
      continue;
    }
    seen.add(identity);
    normalized.push(keyterm);
    if (normalized.length === 1_000) break;
  }
  return normalized;
}

/** Project-level keyterms are explicit and opt-in so base Scribe remains the default price. */
export function readScribeKeyterms(processingConfig: unknown): string[] {
  if (!processingConfig || typeof processingConfig !== "object" || Array.isArray(processingConfig)) {
    return [];
  }
  const raw = (processingConfig as { transcriptionKeyterms?: unknown }).transcriptionKeyterms;
  if (!Array.isArray(raw)) return [];
  return normalizeScribeKeyterms(raw.filter((value): value is string => typeof value === "string"));
}

export function scribePricePerMinuteUsd(
  usesKeyterms: boolean,
  basePricePerHour = env.ELEVENLABS_SCRIBE_PRICE_PER_HOUR_USD,
  keytermPricePerHour = env.ELEVENLABS_SCRIBE_KEYTERM_PRICE_PER_HOUR_USD,
): number {
  return (basePricePerHour + (usesKeyterms ? keytermPricePerHour : 0)) / 60;
}

export async function requestScribe({
  apiKey,
  audioPath,
  language,
  keyterms,
}: Parameters<ScribeRequest>[0]): Promise<ScribeResponse> {
  const audio = await openAsBlob(audioPath, { type: "audio/wav" });
  const form = new FormData();
  form.append("file", audio, path.basename(audioPath));
  form.append("model_id", "scribe_v2");
  if (language && language !== "auto") form.append("language_code", language);
  form.append("timestamps_granularity", "word");
  form.append("diarize", "true");
  form.append("tag_audio_events", "true");
  form.append("no_verbatim", "false");
  for (const keyterm of keyterms) form.append("keyterms", keyterm);

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(envTimeoutMs("ELEVENLABS_SCRIBE_TIMEOUT_MS", 10 * 60_000)),
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 1_000);
    throw new Error(`ElevenLabs Scribe failed with HTTP ${response.status}: ${message}`);
  }
  return (await response.json()) as ScribeResponse;
}

export function parseScribeResponse(response: ScribeResponse): TranscriptionResult {
  const words = response.words
    .filter((item) => item.type === "word")
    .map((item) => ({
      word: item.text,
      startMs: Math.round(item.start * 1_000),
      endMs: Math.round(item.end * 1_000),
      confidence: Math.max(0, Math.min(1, Math.exp(item.logprob ?? 0))),
      isFiller: false,
      deleted: false,
      speakerLabel: item.speaker_id,
    }));
  if (words.length === 0) {
    throw new Error("ElevenLabs Scribe returned no spoken words.");
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const current = words[index];
    const next = words[index + 1];
    if (current.endMs > next.startMs && next.startMs >= current.startMs) {
      current.endMs = next.startMs;
    }
  }

  for (let index = 0; index < words.length; ) {
    const runStartMs = words[index].startMs;
    let runEnd = index + 1;
    while (runEnd < words.length && words[runEnd].startMs === runStartMs) runEnd += 1;
    const run = words.slice(index, runEnd);
    const hasZeroDuration = run.some((word) => word.endMs <= word.startMs);
    if (!hasZeroDuration) {
      index = runEnd;
      continue;
    }

    const nextStartMs = words[runEnd]?.startMs;
    const naturalEndMs = Math.max(...run.map((word) => word.endMs));
    const minimumEndMs = runStartMs + run.length * 80;
    const maximumEndMs = runStartMs + run.length * 500;
    const availableEndMs = Math.max(
      minimumEndMs,
      Math.min(nextStartMs ?? Math.max(naturalEndMs, minimumEndMs), maximumEndMs),
    );
    const durationMs = availableEndMs - runStartMs;
    for (let offset = 0; offset < run.length; offset += 1) {
      run[offset].startMs = runStartMs + Math.round((durationMs * offset) / run.length);
      run[offset].endMs = runStartMs + Math.round((durationMs * (offset + 1)) / run.length);
    }
    index = runEnd;
  }

  let timelineCursorMs = 0;
  for (const word of words) {
    word.startMs = Math.max(word.startMs, timelineCursorMs);
    word.endMs = Math.max(word.endMs, word.startMs + 1);
    timelineCursorMs = word.endMs;
  }

  const segments: TranscriptionResult["segments"] = [];
  let segmentWords: typeof words = [];
  const flush = () => {
    if (segmentWords.length === 0) return;
    segments.push({
      startMs: segmentWords[0].startMs,
      endMs: segmentWords[segmentWords.length - 1].endMs,
      text: segmentWords.map((word) => word.word).join(" "),
      speakerLabel: segmentWords[0].speakerLabel,
      words: segmentWords,
    });
    segmentWords = [];
  };

  for (const word of words) {
    const previous = segmentWords[segmentWords.length - 1];
    if (
      previous &&
      (previous.speakerLabel !== word.speakerLabel || word.startMs - previous.endMs >= 1_200)
    ) {
      flush();
    }
    segmentWords.push(word);
    const durationMs = word.endMs - segmentWords[0].startMs;
    if (/[.!?]["')\]]?$/.test(word.word) || durationMs >= 8_000) flush();
  }
  flush();

  return {
    language: response.language_code || "en",
    segments,
  };
}

export class ScribeTranscriptionProvider implements TranscriptionProvider {
  readonly name = "elevenlabs_scribe_v2";
  lastTelemetry: TranscriptionTelemetry | null = null;

  private readonly apiKey: string | undefined;
  private readonly request: ScribeRequest;
  private readonly defaultKeyterms: string[];

  constructor(options: { apiKey?: string; request?: ScribeRequest; keyterms?: string[] } = {}) {
    this.apiKey = options.apiKey ?? env.ELEVENLABS_API_KEY;
    this.request = options.request ?? requestScribe;
    this.defaultKeyterms = options.keyterms ?? [];
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async transcribe({
    audioPath,
    language,
    keyterms,
  }: {
    audioPath: string;
    language?: string;
    keyterms?: string[];
  }): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new TranscriptionProviderUnavailableError("ELEVENLABS_API_KEY is not configured.");
    }

    const runtime = startRuntimeMeasurement();
    this.lastTelemetry = null;
    try {
      const response = await this.request({
        apiKey: this.apiKey,
        audioPath,
        language,
        keyterms: normalizeScribeKeyterms(keyterms ?? this.defaultKeyterms),
      });
      const result = parseScribeResponse(response);
      this.lastTelemetry = { ...finishRuntimeMeasurement(runtime), outcome: "succeeded" };
      return result;
    } catch (error) {
      this.lastTelemetry = { ...finishRuntimeMeasurement(runtime), outcome: "failed" };
      throw error;
    }
  }
}
