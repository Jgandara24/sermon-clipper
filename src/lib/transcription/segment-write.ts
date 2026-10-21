import type { Prisma } from "@prisma/client";
import type { TranscriptSegmentResult } from "./types";

/**
 * Rows per query. Seven bound values a row keeps a batch at 7,000, far under Postgres's limit of
 * 65,535, so a service of any length still writes.
 */
export const TRANSCRIPT_SEGMENT_BATCH = 1_000;

type SegmentWriter = {
  transcriptSegment: { createMany(args: { data: Prisma.TranscriptSegmentCreateManyInput[] }): Promise<unknown> };
};

/**
 * Writes a transcript's lines in batched queries. One create per line ran past the transcript
 * transaction's 5-second limit on lab sermon 1h (2026-10-20), about 2,500 lines under load, three
 * times; every retry paid the provider for a new transcription.
 */
export async function writeTranscriptSegments(tx: SegmentWriter, transcriptId: string, segments: TranscriptSegmentResult[]) {
  for (let start = 0; start < segments.length; start += TRANSCRIPT_SEGMENT_BATCH) {
    await tx.transcriptSegment.createMany({
      data: segments.slice(start, start + TRANSCRIPT_SEGMENT_BATCH).map((segment, i) => ({
        transcriptId,
        idx: start + i,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speakerLabel: segment.speakerLabel,
        words: segment.words,
      })),
    });
  }
}
