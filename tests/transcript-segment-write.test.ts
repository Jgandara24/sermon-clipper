import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_SEGMENT_BATCH, writeTranscriptSegments } from "@/lib/transcription/segment-write";

const segment = (i: number) => ({
  startMs: i * 1_000,
  endMs: i * 1_000 + 900,
  text: `Line ${i}.`,
  speakerLabel: i % 2 ? "speaker_1" : undefined,
  words: [{ word: `Line ${i}.`, startMs: i * 1_000, endMs: i * 1_000 + 900, confidence: 1, isFiller: false, deleted: false }],
});

// Lab sermon 1h (2026-10-20): one create per line, about 2,500 lines, ran past the transaction's
// 5-second limit under load three times, and every retry paid for a new transcription.
describe("writeTranscriptSegments", () => {
  it("writes the lines in one query, in order, with every field", async () => {
    const tx = { transcriptSegment: { createMany: vi.fn().mockResolvedValue({ count: 3 }) } };
    await writeTranscriptSegments(tx, "transcript-1", [segment(0), segment(1), segment(2)]);
    expect(tx.transcriptSegment.createMany).toHaveBeenCalledTimes(1);
    expect(tx.transcriptSegment.createMany).toHaveBeenCalledWith({
      data: [0, 1, 2].map((i) => ({
        transcriptId: "transcript-1",
        idx: i,
        startMs: i * 1_000,
        endMs: i * 1_000 + 900,
        text: `Line ${i}.`,
        speakerLabel: i % 2 ? "speaker_1" : undefined,
        words: segment(i).words,
      })),
    });
  });

  it("splits a long service into batches that stay far under the database's parameter limit", async () => {
    const tx = { transcriptSegment: { createMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    await writeTranscriptSegments(tx, "transcript-1", Array.from({ length: 2_500 }, (_, i) => segment(i)));
    const batches = tx.transcriptSegment.createMany.mock.calls.map(([args]) => args.data);
    expect(TRANSCRIPT_SEGMENT_BATCH).toBe(1_000);
    expect(batches.map((rows) => rows.length)).toEqual([1_000, 1_000, 500]);
    expect(batches.flat().map((row) => row.idx)).toEqual(Array.from({ length: 2_500 }, (_, i) => i));
  });

  it("writes nothing for an empty transcript", async () => {
    const tx = { transcriptSegment: { createMany: vi.fn() } };
    await writeTranscriptSegments(tx, "transcript-1", []);
    expect(tx.transcriptSegment.createMany).not.toHaveBeenCalled();
  });
});
