// Reading the probe's WAV by byte range.
//
// The probe writes a 16kHz mono PCM WAV of every source, for transcription. The timeline's Audio
// row wants real amplitude for the window it is looking at, and a sermon's WAV is tens of
// megabytes: fetching the whole of it to draw a few hundred bars is the wrong trade. PCM is
// trivially seekable — a time is a byte offset — so the header is read once, the window's frames
// are read by range, and the peaks are reduced here, pure and tested.

export class WavFormatError extends Error {}

export type WavHeader = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes per frame: one sample for every channel. */
  blockAlign: number;
  /** Where the samples begin. Not 44: ffmpeg writes other chunks before the data. */
  dataOffset: number;
  dataBytes: number;
};

export type WavRange = {
  /** Inclusive byte range of the frames inside the window. */
  start: number;
  end: number;
  /** The frame the range begins at, so the peaks can be placed on the window's own timeline. */
  firstSample: number;
  sampleCount: number;
};

/** Enough of the file to hold the RIFF header, the format chunk, and whatever ffmpeg puts before the data. */
export const WAV_HEADER_PROBE_BYTES = 4_096;

/** Below this, a window is treated as silence rather than scaled up to full height. */
export const PEAK_NOISE_FLOOR = 0.05;

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * The format and the data chunk's place, from the first bytes of the file.
 *
 * Walks the chunks rather than assuming the data starts at byte 44: ffmpeg writes a LIST chunk
 * before it, and a parser that skips 44 bytes reads the chunk's text as samples. Only 16-bit PCM
 * is accepted, which is what the probe writes; anything else is a format error, not a guess.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader {
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    throw new WavFormatError("Not a RIFF/WAVE file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Omit<WavHeader, "dataOffset" | "dataBytes"> | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) throw new WavFormatError("Truncated format chunk.");
      const encoding = view.getUint16(body, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (encoding !== 1 || bitsPerSample !== 16) {
        throw new WavFormatError("Only 16-bit PCM WAV is supported.");
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample,
      };
    } else if (id === "data") {
      if (!format) throw new WavFormatError("Data chunk before format chunk.");
      return { ...format, dataOffset: body, dataBytes: size };
    }
    // Chunks are word-aligned: an odd-sized one is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  throw new WavFormatError("No data chunk within the bytes read.");
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The bytes holding the frames inside `[fromMs, toMs)`, whole frames only, clamped to the data.
 * Null when the window holds no frames at all.
 */
export function wavByteRange(header: WavHeader, fromMs: number, toMs: number): WavRange | null {
  const totalFrames = Math.floor(header.dataBytes / header.blockAlign);
  const firstSample = clampInt(Math.floor((fromMs * header.sampleRate) / 1000), 0, totalFrames);
  const endSample = clampInt(Math.ceil((toMs * header.sampleRate) / 1000), 0, totalFrames);
  if (endSample <= firstSample) return null;
  return {
    start: header.dataOffset + firstSample * header.blockAlign,
    end: header.dataOffset + endSample * header.blockAlign - 1,
    firstSample,
    sampleCount: endSample - firstSample,
  };
}

/**
 * The loudest sample in each of `bucketCount` equal buckets across `[fromMs, toMs)`, as a fraction
 * of full scale, taking the loudest channel where there are several.
 *
 * `bytes` are the frames a `wavByteRange` fetched, and `firstSample` says where they sit, so a
 * fetch that was clamped short still lands its peaks in the right bars and leaves the rest at 0.
 */
export function pcmPeaks(
  header: WavHeader,
  bytes: Uint8Array,
  firstSample: number,
  fromMs: number,
  toMs: number,
  bucketCount: number,
): number[] {
  const peaks = new Array<number>(Math.max(0, bucketCount)).fill(0);
  const span = toMs - fromMs;
  if (!(span > 0) || bucketCount < 1) return peaks;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / header.blockAlign);
  for (let frame = 0; frame < frames; frame += 1) {
    const ms = ((firstSample + frame) * 1000) / header.sampleRate;
    const bucket = Math.floor(((ms - fromMs) / span) * bucketCount);
    if (bucket < 0 || bucket >= bucketCount) continue;
    let peak = 0;
    for (let channel = 0; channel < header.channels; channel += 1) {
      const value = Math.abs(view.getInt16(frame * header.blockAlign + channel * 2, true));
      if (value > peak) peak = value;
    }
    if (peak > peaks[bucket]) peaks[bucket] = peak;
  }
  return peaks.map((peak) => peak / 32_768);
}

/**
 * Scales a window so its loudest bar is full height — a quiet passage still reads as a shape —
 * but never below the noise floor, so near-silence stays flat instead of being blown up.
 */
export function normalisePeaks(peaks: number[], floor = PEAK_NOISE_FLOOR): number[] {
  const loudest = Math.max(floor, ...peaks);
  return peaks.map((peak) => peak / loudest);
}
