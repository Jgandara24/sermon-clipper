import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { sourceVideo: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/api/auth", () => ({
  requireApiWorkspace: vi.fn(async () => ({ workspace: { id: "ws-1" }, user: { id: "user-1" } })),
}));

vi.mock("@/lib/storage", () => ({
  getStorageProvider: vi.fn(),
}));

import { parsePeaksQuery, readAudioPeaks, type RangeReader } from "@/lib/media/audio-peaks";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage";
import { GET } from "@/app/api/videos/[id]/peaks/route";

/** A canonical 16-bit PCM WAV: silence with one burst, the way the probe's audio would carry speech. */
function buildWav(samples: Int16Array, sampleRate = 16_000): Buffer {
  const dataBytes = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) bytes.writeInt16LE(samples[i], 44 + i * 2);
  return bytes;
}

function burst(durationMs: number, atMs: number, burstMs: number, amplitude: number) {
  const rate = 16_000;
  const samples = new Int16Array((durationMs * rate) / 1000);
  for (let i = (atMs * rate) / 1000; i < ((atMs + burstMs) * rate) / 1000; i += 1) {
    samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

/** Storage that serves one object by range and counts how much of it was asked for. */
function fakeStorage(objects: Record<string, Buffer>) {
  const reads: Array<{ key: string; start: number; end: number }> = [];
  const reader: RangeReader = {
    async readRange(key, start, end) {
      reads.push({ key, start, end });
      const object = objects[key];
      if (!object) throw new Error(`no object ${key}`);
      return object.subarray(start, Math.min(object.length, end + 1));
    },
  };
  return { reader, reads };
}

const WAV = buildWav(burst(4_000, 1_000, 500, 16_384));

describe("parsePeaksQuery", () => {
  const query = (params: Record<string, string>) => parsePeaksQuery(new URLSearchParams(params));

  it("reads a window and a bucket count", () => {
    expect(query({ fromMs: "1000", toMs: "3000", buckets: "40" })).toEqual({
      fromMs: 1_000,
      toMs: 3_000,
      buckets: 40,
    });
  });

  it("refuses an empty or backwards window, a silly bucket count, and anything missing", () => {
    expect(query({ fromMs: "3000", toMs: "1000", buckets: "40" })).toBeNull();
    expect(query({ fromMs: "1000", toMs: "1000", buckets: "40" })).toBeNull();
    expect(query({ fromMs: "-5", toMs: "1000", buckets: "40" })).toBeNull();
    expect(query({ fromMs: "0", toMs: "1000", buckets: "0" })).toBeNull();
    expect(query({ fromMs: "0", toMs: "1000", buckets: "5000" })).toBeNull();
    expect(query({ fromMs: "0", toMs: "1000" })).toBeNull();
    expect(query({ fromMs: "x", toMs: "1000", buckets: "10" })).toBeNull();
  });

  it("refuses a window longer than an hour, which no timeline shows", () => {
    expect(query({ fromMs: "0", toMs: String(61 * 60_000), buckets: "10" })).toBeNull();
  });
});

describe("readAudioPeaks", () => {
  it("reads the header, then only the window's bytes, and returns one peak per bucket", async () => {
    const { reader, reads } = fakeStorage({ "audio/ws-1/v1.wav": WAV });

    const peaks = await readAudioPeaks(reader, "audio/ws-1/v1.wav", {
      fromMs: 0,
      toMs: 2_000,
      buckets: 4,
    });

    expect(peaks).toEqual([0, 0, 0.5, 0]);
    // A header probe, then the window: never the whole file.
    expect(reads).toHaveLength(2);
    expect(reads[0]).toEqual({ key: "audio/ws-1/v1.wav", start: 0, end: 4_095 });
    expect(reads[1]).toEqual({ key: "audio/ws-1/v1.wav", start: 44, end: 44 + 64_000 - 1 });
  });

  it("answers silence for a window past the end of the audio without a second read", async () => {
    const { reader, reads } = fakeStorage({ "audio/ws-1/v1.wav": WAV });

    const peaks = await readAudioPeaks(reader, "audio/ws-1/v1.wav", {
      fromMs: 10_000,
      toMs: 11_000,
      buckets: 3,
    });

    expect(peaks).toEqual([0, 0, 0]);
    expect(reads).toHaveLength(1);
  });
});

describe("GET /api/videos/[id]/peaks", () => {
  const params = Promise.resolve({ id: "video-1" });
  const request = (search: string) =>
    new Request(`https://app.example/api/videos/video-1/peaks?${search}`);

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.sourceVideo.findUnique as Mock).mockResolvedValue({
      id: "video-1",
      workspaceId: "ws-1",
      audioKey: "audio/ws-1/video-1.wav",
    });
    (getStorageProvider as Mock).mockReturnValue(
      fakeStorage({ "audio/ws-1/video-1.wav": WAV }).reader,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the window's peaks, privately cacheable", async () => {
    const response = (await GET(request("fromMs=0&toMs=2000&buckets=4"), { params })) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    const json = await response.json();
    expect(json.data).toEqual({ fromMs: 0, toMs: 2_000, peaks: [0, 0, 0.5, 0] });
  });

  it("rejects a bad window before touching the database", async () => {
    const response = (await GET(request("fromMs=5&toMs=1&buckets=4"), { params })) as Response;

    expect(response.status).toBe(400);
    expect(prisma.sourceVideo.findUnique).not.toHaveBeenCalled();
  });

  it("is 404 when the video has no extracted audio yet, so the row can fall back", async () => {
    (prisma.sourceVideo.findUnique as Mock).mockResolvedValue({
      id: "video-1",
      workspaceId: "ws-1",
      audioKey: null,
    });

    const response = (await GET(request("fromMs=0&toMs=2000&buckets=4"), { params })) as Response;

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("AUDIO_UNAVAILABLE");
  });

  it("is 403 for a video in another workspace", async () => {
    (prisma.sourceVideo.findUnique as Mock).mockResolvedValue({
      id: "video-1",
      workspaceId: "ws-other",
      audioKey: "audio/ws-other/video-1.wav",
    });

    const response = (await GET(request("fromMs=0&toMs=2000&buckets=4"), { params })) as Response;

    expect(response.status).toBe(403);
  });

  it("is 404 when the key is recorded but the object is gone, as retention may leave it", async () => {
    (getStorageProvider as Mock).mockReturnValue({
      async readRange() {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });

    const response = (await GET(request("fromMs=0&toMs=2000&buckets=4"), { params })) as Response;

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("AUDIO_UNAVAILABLE");
  });

  it("reports an unreadable WAV as a server fault rather than drawing from garbage", async () => {
    (getStorageProvider as Mock).mockReturnValue(
      fakeStorage({ "audio/ws-1/video-1.wav": Buffer.from("this is not a wav file at all") }).reader,
    );

    const response = (await GET(request("fromMs=0&toMs=2000&buckets=4"), { params })) as Response;

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("AUDIO_UNREADABLE");
  });
});
