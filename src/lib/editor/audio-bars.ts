// Bars for the Audio row from real peaks, on the source's own timeline.
//
// The peaks arrive from the server in fixed chunks — a minute of source at twenty peaks a second
// — and are kept by chunk. Whatever window the timeline shows, at whatever zoom, mid-drag or
// settled, its bars are reduced from those chunks here: the same pure shape `wordDensityBars`
// has, so a window never has to wait for a request to move.

import type { TrimViewport } from "./trim";

export const PEAKS_PER_SECOND = 20;
export const PEAK_CHUNK_MS = 60_000;
export const PEAKS_PER_CHUNK = (PEAK_CHUNK_MS / 1000) * PEAKS_PER_SECOND;

export type PeakChunks = ReadonlyMap<number, readonly number[]>;

/** The chunks a window touches, first to last. */
export function chunkIndexesFor(view: TrimViewport): number[] {
  if (!(view.end > view.start)) return [];
  const first = Math.floor(view.start / PEAK_CHUNK_MS);
  const last = Math.floor((view.end - 1) / PEAK_CHUNK_MS);
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/**
 * One bar per bucket across the window: the loudest peak whose slot overlaps the bucket. A bucket
 * narrower than a peak takes the peak it sits in; a bucket over a chunk not yet loaded is 0. Null
 * when no chunk of the window has arrived, so the row can draw what it has instead.
 */
export function peakBars(
  chunks: PeakChunks,
  view: TrimViewport,
  bucketCount: number,
): number[] | null {
  const indexes = chunkIndexesFor(view);
  if (bucketCount < 1 || !indexes.some((index) => chunks.has(index))) return null;

  const span = view.end - view.start;
  const peakMs = 1000 / PEAKS_PER_SECOND;
  const bars = new Array<number>(bucketCount).fill(0);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const from = view.start + (span * bucket) / bucketCount;
    const to = view.start + (span * (bucket + 1)) / bucketCount;
    const firstPeak = Math.floor(from / peakMs);
    const lastPeak = Math.ceil(to / peakMs) - 1;
    let loudest = 0;
    for (let peak = firstPeak; peak <= lastPeak; peak += 1) {
      const chunkIndex = Math.floor(peak / PEAKS_PER_CHUNK);
      const chunk = chunks.get(chunkIndex);
      if (!chunk) continue;
      const value = chunk[peak - chunkIndex * PEAKS_PER_CHUNK] ?? 0;
      if (value > loudest) loudest = value;
    }
    bars[bucket] = loudest;
  }
  return bars;
}
