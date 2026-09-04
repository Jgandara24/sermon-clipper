// The peaks route's work, apart from HTTP: what a request may ask for, and how the answer is read
// from storage. Kept off the route so it is tested with a fake reader and no server.

import {
  parseWavHeader,
  pcmPeaks,
  WAV_HEADER_PROBE_BYTES,
  wavByteRange,
  type WavHeader,
} from "./wav";

export type PeaksQuery = { fromMs: number; toMs: number; buckets: number };

/** The most bars any row draws; a request for more is not a timeline asking. */
export const MAX_PEAK_BUCKETS = 2_000;
/** Longer than any window the timeline shows, and more WAV than one request should read. */
export const MAX_PEAK_WINDOW_MS = 60 * 60_000;

/**
 * True when storage says the object is not there — a file that does not exist, or an S3 key that
 * does not. Extracted audio is cheaply re-derivable and retention may remove it; that is a
 * missing artifact to fall back from, not a fault.
 */
export function isMissingObjectError(error: unknown): boolean {
  const code = (error as { code?: unknown; name?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  return code === "ENOENT" || name === "NoSuchKey" || name === "NotFound";
}

/** Whatever can serve a byte range of an object — the storage provider, or a fake in a test. */
export type RangeReader = {
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;
};

function integer(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** The window and bar count a request asks for, or null when it is not one a row would ask. */
export function parsePeaksQuery(params: URLSearchParams): PeaksQuery | null {
  const fromMs = integer(params.get("fromMs"));
  const toMs = integer(params.get("toMs"));
  const buckets = integer(params.get("buckets"));
  if (fromMs === null || toMs === null || buckets === null) return null;
  if (fromMs < 0 || toMs <= fromMs || toMs - fromMs > MAX_PEAK_WINDOW_MS) return null;
  if (buckets < 1 || buckets > MAX_PEAK_BUCKETS) return null;
  return { fromMs, toMs, buckets };
}

/**
 * One peak per bucket across the window, read from the WAV by range: the header once, then only
 * the window's frames. A window past the end of the audio is silence, and costs one read.
 */
export async function readAudioPeaks(
  reader: RangeReader,
  audioKey: string,
  query: PeaksQuery,
): Promise<number[]> {
  const header: WavHeader = parseWavHeader(
    await reader.readRange(audioKey, 0, WAV_HEADER_PROBE_BYTES - 1),
  );
  const range = wavByteRange(header, query.fromMs, query.toMs);
  if (!range) return new Array<number>(query.buckets).fill(0);
  const bytes = await reader.readRange(audioKey, range.start, range.end);
  return pcmPeaks(header, bytes, range.firstSample, query.fromMs, query.toMs, query.buckets);
}
