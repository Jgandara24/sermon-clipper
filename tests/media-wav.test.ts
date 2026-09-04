import { describe, expect, it } from "vitest";
import {
  normalisePeaks,
  parseWavHeader,
  pcmPeaks,
  wavByteRange,
  WavFormatError,
} from "@/lib/media/wav";

/** A canonical 16-bit PCM WAV in memory, the way ffmpeg writes the probe's audio. */
function buildWav(
  samples: Int16Array,
  { sampleRate = 16_000, channels = 1, extraChunk = false } = {},
): Uint8Array {
  const blockAlign = channels * 2;
  const dataBytes = samples.length * 2;
  const extra = extraChunk ? 8 + 4 : 0;
  const bytes = new Uint8Array(44 + extra + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + extra + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  let offset = 36;
  if (extraChunk) {
    // ffmpeg writes a LIST chunk before the data; a parser that assumes byte 44 reads garbage.
    ascii(offset, "LIST");
    view.setUint32(offset + 4, 4, true);
    ascii(offset + 8, "INFO");
    offset += 12;
  }
  ascii(offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let i = 0; i < samples.length; i += 1) view.setInt16(offset + i * 2, samples[i], true);
  return bytes;
}

/** Silence with one burst: `amplitude` for `burstMs` starting at `atMs`. */
function burst(durationMs: number, atMs: number, burstMs: number, amplitude: number) {
  const rate = 16_000;
  const samples = new Int16Array((durationMs * rate) / 1000);
  const from = (atMs * rate) / 1000;
  const to = ((atMs + burstMs) * rate) / 1000;
  for (let i = from; i < to; i += 1) samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  return samples;
}

describe("parseWavHeader", () => {
  it("reads the format and finds the data chunk", () => {
    const header = parseWavHeader(buildWav(new Int16Array(160)));
    expect(header).toEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      blockAlign: 2,
      dataOffset: 44,
      dataBytes: 320,
    });
  });

  it("walks past chunks ffmpeg writes before the data rather than assuming byte 44", () => {
    const header = parseWavHeader(buildWav(new Int16Array(160), { extraChunk: true }));
    expect(header.dataOffset).toBe(56);
    expect(header.dataBytes).toBe(320);
  });

  it("refuses anything that is not 16-bit PCM WAV", () => {
    expect(() => parseWavHeader(new Uint8Array(64))).toThrow(WavFormatError);
    const wav = buildWav(new Int16Array(16));
    wav[34] = 8; // bitsPerSample
    expect(() => parseWavHeader(wav)).toThrow(WavFormatError);
  });
});

describe("wavByteRange", () => {
  const header = parseWavHeader(buildWav(new Int16Array(16_000 * 3)));

  it("maps a time window to whole frames of the data chunk", () => {
    expect(wavByteRange(header, 1_000, 2_000)).toEqual({
      start: 44 + 32_000,
      end: 44 + 64_000 - 1,
      firstSample: 16_000,
      sampleCount: 16_000,
    });
  });

  it("clamps to the data and is null when nothing is inside it", () => {
    expect(wavByteRange(header, 2_500, 9_000)).toEqual({
      start: 44 + 80_000,
      end: 44 + 96_000 - 1,
      firstSample: 40_000,
      sampleCount: 8_000,
    });
    expect(wavByteRange(header, 5_000, 6_000)).toBeNull();
    expect(wavByteRange(header, -1_000, 0)).toBeNull();
  });
});

describe("pcmPeaks", () => {
  it("is the loudest sample in each bucket, as a fraction of full scale", () => {
    const samples = burst(1_000, 250, 250, 16_384);
    const wav = buildWav(samples);
    const header = parseWavHeader(wav);
    const range = wavByteRange(header, 0, 1_000)!;
    const bytes = wav.subarray(range.start, range.end + 1);

    expect(pcmPeaks(header, bytes, range.firstSample, 0, 1_000, 4)).toEqual([0, 0.5, 0, 0]);
  });

  it("buckets on the window's own timeline, so a partial fetch still lands in the right bar", () => {
    const samples = burst(2_000, 1_500, 250, 32_767);
    const wav = buildWav(samples);
    const header = parseWavHeader(wav);
    const range = wavByteRange(header, 1_000, 2_000)!;
    const bytes = wav.subarray(range.start, range.end + 1);

    const peaks = pcmPeaks(header, bytes, range.firstSample, 1_000, 2_000, 4);
    expect(peaks[2]).toBeCloseTo(1, 3);
    expect(peaks[0]).toBe(0);
    expect(peaks[3]).toBe(0);
  });

  it("is zero past the end of the data rather than NaN or a stale value", () => {
    const wav = buildWav(burst(1_000, 0, 1_000, 8_192));
    const header = parseWavHeader(wav);
    const range = wavByteRange(header, 0, 2_000)!;
    const bytes = wav.subarray(range.start, range.end + 1);

    expect(pcmPeaks(header, bytes, range.firstSample, 0, 2_000, 4)).toEqual([0.25, 0.25, 0, 0]);
  });

  it("takes the loudest channel when there are several", () => {
    const stereo = new Int16Array(32);
    stereo[1] = 16_384; // right channel, first frame
    const wav = buildWav(stereo, { channels: 2 });
    const header = parseWavHeader(wav);
    const range = wavByteRange(header, 0, 1)!;
    const bytes = wav.subarray(range.start, range.end + 1);

    expect(pcmPeaks(header, bytes, range.firstSample, 0, 1, 1)).toEqual([0.5]);
  });
});

describe("normalisePeaks", () => {
  it("scales the window so its loudest bar is full height", () => {
    expect(normalisePeaks([0.1, 0.4, 0.2])).toEqual([0.25, 1, 0.5]);
  });

  it("leaves near-silence flat instead of blowing it up to full height", () => {
    expect(normalisePeaks([0.001, 0.002, 0])).toEqual([0.02, 0.04, 0]);
  });

  it("is empty for empty", () => {
    expect(normalisePeaks([])).toEqual([]);
  });
});
