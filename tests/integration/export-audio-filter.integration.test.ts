import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "@/lib/env";
import { buildExportAudioFilter } from "@/lib/export/render";

const exec = promisify(execFile);

/** Decode the encoded result so this measures actual audio, not filtergraph text. */
async function rms(file: string): Promise<number> {
  const { stdout } = await exec(ffmpegPath(), ["-v", "error", "-i", file,
    "-f", "f64le", "-acodec", "pcm_f64le", "-ar", "48000", "pipe:1"],
  { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  let sum = 0;
  for (let i = 0; i < stdout.length; i += 8) sum += stdout.readDoubleLE(i) ** 2;
  return Math.sqrt(sum / (stdout.length / 8));
}

describe("normalised AAC followed by the document volume", () => {
  it.each(["mono", "stereo"])("renders %s at half the original gain without a format negotiation failure", async (layout) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "export-audio-gain-"));
    try {
      const source = path.join(dir, "source.m4a");
      // A two-second signal misses the FFmpeg 6 dynamic-loudnorm failure. Use the
      // same 12-second source / six-second excerpt shape as the full export gate.
      await exec(ffmpegPath(), ["-v", "error", "-y", "-f", "lavfi", "-i",
        `sine=frequency=440:sample_rate=44100:duration=12,aformat=channel_layouts=${layout}`,
        "-c:a", "aac", source]);
      const files = [path.join(dir, "full.m4a"), path.join(dir, "half.m4a")];
      for (const [i, volume] of [1, 0.5].entries()) {
        await exec(ffmpegPath(), ["-v", "error", "-y", "-ss", "2", "-i", source, "-t", "6",
          "-af", buildExportAudioFilter(volume), "-c:a", "aac", "-b:a", "192k", files[i]]);
      }
      const [full, half] = await Promise.all(files.map(rms));
      expect(full).toBeGreaterThan(0);
      expect(half / full).toBeCloseTo(0.5, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
