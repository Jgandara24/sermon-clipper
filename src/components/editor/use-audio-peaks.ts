"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  chunkIndexesFor,
  PEAK_CHUNK_MS,
  PEAKS_PER_CHUNK,
  peakBars,
} from "@/lib/editor/audio-bars";
import type { TrimViewport } from "@/lib/editor/trim";

/**
 * Real audio peaks for the window the timeline shows, fetched by the minute and kept.
 *
 * Each chunk is asked for once and remembered for the life of the editor, so a window that has
 * been looked at costs nothing to look at again, and a drag or a zoom is reduced locally from the
 * chunks already here. A 404 means the video has no extracted audio: nothing is asked again, and
 * the row draws from the transcript instead. Any other failure is forgotten, so the next window
 * change tries again.
 *
 * Returns null until the first chunk of the window has arrived.
 */
export function useAudioPeaks(
  videoId: string,
  view: TrimViewport,
  bucketCount: number,
  sourceDurationMs: number,
): number[] | null {
  // The chunks are state, replaced immutably as each arrives, so a render reads a settled value.
  // What is in flight, and whether the video has audio at all, are bookkeeping only effects touch.
  const [chunks, setChunks] = useState<ReadonlyMap<number, number[]>>(() => new Map());
  const loadedRef = useRef(new Set<number>());
  const pendingRef = useRef(new Set<number>());
  const unavailableRef = useRef(false);

  // Only chunks the source actually has: a window's padding can reach past the end of the media.
  const lastChunk = Math.max(0, Math.floor((sourceDurationMs - 1) / PEAK_CHUNK_MS));
  const wanted = chunkIndexesFor(view).filter((index) => index <= lastChunk);
  const wantedKey = wanted.join(",");

  useEffect(() => {
    if (unavailableRef.current) return;
    // One controller per run of this effect, so its cleanup aborts exactly what it started.
    const controller = new AbortController();
    const pending = pendingRef.current;
    const started: number[] = [];
    for (const index of wantedKey === "" ? [] : wantedKey.split(",").map(Number)) {
      if (loadedRef.current.has(index) || pending.has(index)) continue;
      pending.add(index);
      started.push(index);
      const query = new URLSearchParams({
        fromMs: String(index * PEAK_CHUNK_MS),
        toMs: String((index + 1) * PEAK_CHUNK_MS),
        buckets: String(PEAKS_PER_CHUNK),
      });
      fetch(`/api/videos/${videoId}/peaks?${query}`, { signal: controller.signal })
        .then(async (response) => {
          if (response.status === 404) {
            unavailableRef.current = true;
            return;
          }
          if (!response.ok) return;
          const json = (await response.json()) as { data?: { peaks?: unknown } };
          const peaks = json.data?.peaks;
          if (!Array.isArray(peaks)) return;
          const values = peaks.map((peak) => (typeof peak === "number" ? peak : 0));
          loadedRef.current.add(index);
          setChunks((current) => new Map(current).set(index, values));
        })
        .catch(() => {
          // Aborted or failed: forgotten, so a later window change asks again.
        })
        .finally(() => {
          // An aborted request was already forgotten by the cleanup below, and the run that
          // replaced it may have asked again; only a request that ran to its end clears itself.
          if (!controller.signal.aborted) pending.delete(index);
        });
    }
    return () => {
      controller.abort();
      // Synchronously, not in the request's own `finally`: under Strict Mode React runs this
      // cleanup and the next mount back to back, and a chunk still marked pending would never be
      // asked for at all.
      for (const index of started) pending.delete(index);
    };
  }, [videoId, wantedKey]);

  const { start, end } = view;
  return useMemo(() => peakBars(chunks, { start, end }, bucketCount), [chunks, start, end, bucketCount]);
}
