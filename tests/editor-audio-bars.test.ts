import { describe, expect, it } from "vitest";
import {
  chunkIndexesFor,
  PEAK_CHUNK_MS,
  PEAKS_PER_SECOND,
  peakBars,
} from "@/lib/editor/audio-bars";

/** A chunk whose every peak is `value`, or a function of the peak's index. */
function chunk(value: number | ((index: number) => number)) {
  const count = (PEAK_CHUNK_MS / 1000) * PEAKS_PER_SECOND;
  return Array.from({ length: count }, (_, index) =>
    typeof value === "function" ? value(index) : value,
  );
}

describe("chunkIndexesFor", () => {
  it("names every chunk the window touches, and only those", () => {
    expect(chunkIndexesFor({ start: 0, end: 6_000 })).toEqual([0]);
    expect(chunkIndexesFor({ start: 41_000, end: 164_000 })).toEqual([0, 1, 2]);
    expect(chunkIndexesFor({ start: 60_000, end: 120_000 })).toEqual([1]);
  });

  it("is empty for a window with no width", () => {
    expect(chunkIndexesFor({ start: 5, end: 5 })).toEqual([]);
  });
});

describe("peakBars", () => {
  it("is null until any chunk of the window has arrived, so the row can fall back", () => {
    expect(peakBars(new Map(), { start: 0, end: 6_000 }, 6)).toBeNull();
  });

  it("is the loudest peak inside each bucket, on the source's own timeline", () => {
    // Chunk 0: silence except one loud peak at 2.5s (index 50 at 20 per second).
    const chunks = new Map([[0, chunk((index) => (index === 50 ? 0.8 : 0))]]);

    expect(peakBars(chunks, { start: 0, end: 6_000 }, 6)).toEqual([0, 0, 0.8, 0, 0, 0]);
  });

  it("reads across a chunk boundary", () => {
    const chunks = new Map([
      [0, chunk(0.2)],
      [1, chunk(0.6)],
    ]);

    // 50s to 70s in two bars: the first is all chunk 0, the second is all chunk 1.
    expect(peakBars(chunks, { start: 50_000, end: 70_000 }, 2)).toEqual([0.2, 0.6]);
  });

  it("draws nothing where a chunk is still missing, not something made up", () => {
    const chunks = new Map([[1, chunk(0.6)]]);

    expect(peakBars(chunks, { start: 50_000, end: 70_000 }, 2)).toEqual([0, 0.6]);
  });

  it("fills a bucket narrower than a peak from the peak it sits in", () => {
    // Zoomed far in: a 50ms window, four bars of 12.5ms each, all inside one 50ms peak slot.
    const chunks = new Map([[0, chunk((index) => (index === 20 ? 0.5 : 0))]]);

    expect(peakBars(chunks, { start: 1_000, end: 1_050 }, 4)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
