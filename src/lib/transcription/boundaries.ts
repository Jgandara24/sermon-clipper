import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";

export const TRANSCRIPT_BOUNDARY_VERSION = "transcript-boundaries-v1";
const time = z.number().int().nonnegative().safe();
const wordSchema = z.object({
  text: z.string().refine(text => text.trim().length > 0), startMs: time, endMs: time,
  speakerId: z.string().min(1).nullable(),
}).strict().refine(word => word.endMs >= word.startMs, { message: "Word timestamps must not run backward." });
export const transcriptBoundarySettingsSchema = z.object({
  paragraphSilenceMinimumMs: z.number().int().positive().safe(),
  splitOnSpeakerChange: z.boolean(),
  // Literal complete tokens, including punctuation. No language or abbreviation list is assumed.
  nonTerminalTokens: z.array(z.string().trim().min(1)),
}).strict();
const inputSchema = z.object({
  submittedAudioSha256: sha256Schema,
  sourceInterval: sourceIntervalSchema,
  // Words use the submitted audio clock. Acoustic silence already uses the source clock.
  words: z.array(wordSchema),
  acousticSilence: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), evidenceSha256: sha256Schema,
      intervals: z.array(sourceIntervalSchema) }).strict(),
    z.object({ status: z.literal("unavailable"), reason: z.string().trim().min(1) }).strict(),
  ]),
  settings: transcriptBoundarySettingsSchema,
}).strict();
export type TranscriptBoundaryInput = z.infer<typeof inputSchema>;
type Reason = "terminal-punctuation" | "speaker-change" | "acoustic-silence" | "transcript-end";
type Span = { startWord: number; endWord: number; startMs: number; endMs: number; endReason: Reason };

/** Deterministic structural facts. These are not semantic or forbidden-content classifications. */
export function deriveTranscriptBoundaries(value: TranscriptBoundaryInput) {
  const input = inputSchema.parse(value);
  const durationMs = input.sourceInterval.endMs - input.sourceInterval.startMs;
  let previousStart = -1;
  const words = input.words.map(word => {
    if (word.startMs < previousStart || word.endMs > durationMs) throw new Error("TRANSCRIPT_WORD_CLOCK_INVALID");
    previousStart = word.startMs;
    return { ...word, startMs: word.startMs + input.sourceInterval.startMs,
      endMs: word.endMs + input.sourceInterval.startMs };
  });
  const silences = input.acousticSilence.status === "available" ? input.acousticSilence.intervals : [];
  let previousEnd = input.sourceInterval.startMs;
  for (const silence of silences) {
    if (silence.startMs < previousEnd || silence.endMs > input.sourceInterval.endMs) {
      throw new Error("TRANSCRIPT_SILENCE_CLOCK_INVALID");
    }
    previousEnd = silence.endMs;
  }
  const inputSha256 = rangeEvidenceSha256(input);
  const provenance = { status: "derived" as const, algorithmVersion: TRANSCRIPT_BOUNDARY_VERSION, inputSha256 };
  const sentences: Span[] = [], paragraphs: Span[] = [];
  const nonTerminal = new Set(input.settings.nonTerminalTokens);
  let sentenceStart = 0, paragraphStart = 0, silenceIndex = 0, coveredEnd = input.sourceInterval.startMs;
  const span = (start: number, end: number, reason: Reason): Span => ({
    startWord: start, endWord: end, startMs: words[start].startMs,
    endMs: words.slice(start, end).reduce((max, word) => Math.max(max, word.endMs), words[start].endMs), endReason: reason,
  });
  for (let i = 0; i < words.length; i++) {
    const word = words[i], next = words[i + 1];
    coveredEnd = Math.max(coveredEnd, word.endMs);
    while (silenceIndex < silences.length && (silences[silenceIndex].startMs < coveredEnd ||
      silences[silenceIndex].endMs - silences[silenceIndex].startMs < input.settings.paragraphSilenceMinimumMs)) silenceIndex++;
    const silence = silences[silenceIndex];
    const acousticBreak = next && silence && silence.startMs >= coveredEnd && silence.endMs <= next.startMs &&
      silence.endMs - silence.startMs >= input.settings.paragraphSilenceMinimumMs;
    const speakerBreak = next && input.settings.splitOnSpeakerChange && word.speakerId !== null &&
      next.speakerId !== null && word.speakerId !== next.speakerId;
    const paragraphReason: Reason | null = !next ? "transcript-end" : acousticBreak ? "acoustic-silence" :
      speakerBreak ? "speaker-change" : null;
    const sentenceReason = paragraphReason ??
      (/[.!?。！？]["'”’»）)\]]*$/u.test(word.text) && !nonTerminal.has(word.text) ? "terminal-punctuation" : null);
    if (sentenceReason) { sentences.push(span(sentenceStart, i + 1, sentenceReason)); sentenceStart = i + 1; }
    if (paragraphReason) { paragraphs.push(span(paragraphStart, i + 1, paragraphReason)); paragraphStart = i + 1; }
  }
  return { version: TRANSCRIPT_BOUNDARY_VERSION, inputSha256, sourceInterval: input.sourceInterval,
    submittedAudioSha256: input.submittedAudioSha256, words, silences, sentences, paragraphs,
    capabilities: { sentences: provenance, paragraphs: provenance,
      silences: input.acousticSilence.status === "available" ? provenance : input.acousticSilence },
    acousticEvidenceSha256: input.acousticSilence.status === "available" ? input.acousticSilence.evidenceSha256 : null,
    settings: input.settings };
}
