/** Real local files and CLI process. No database, storage client, or provider is used. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { measureLocalMedia } from "@/lib/evaluation/local-media-measurement";

const exec = promisify(execFile);
const localEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "test" as const };

it("measures a real local audio range through the CLI without claiming quality or overwriting a report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-media-measurement-"));
  const source = path.join(directory, "private source.mp4");
  const artifact = path.join(directory, "private audio.flac");
  const output = path.join(directory, "measurements.json");
  const commandOptions = { env: localEnvironment, timeout: 30_000, killSignal: "SIGKILL" as const };
  try {
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
      "-metadata", "title=private-sermon-title", source], commandOptions);
    await exec("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", source, "-t", "1", "-vn",
      "-ac", "1", "-ar", "16000", "-c:a", "flac", artifact], commandOptions);
    const args = ["--import", "tsx", "scripts/measure-local-media.ts", "--source", source,
      "--artifact", artifact, "--artifact-id", "synthetic-audio-range", "--kind", "audio",
      "--source-start-ms", "500", "--source-end-ms", "1500", "--output", output];
    await exec(process.execPath, args, commandOptions);
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);
    expect(report.source.probe).toMatchObject({ durationMs: 2000, video: { width: 320, height: 180 } });
    expect(report.artifact.probe).toMatchObject({ durationMs: 1000, audio: { codec: "flac", channels: 1, sampleRateHz: 16000 } });
    expect(report.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.artifact.sha256).not.toBe(report.source.sha256);
    expect(report.declaredMapping).toMatchObject({ sourceStartMs: 500, sourceEndMs: 1500, verification: "NOT_VERIFIED" });
    expect(report.observations.durationDifferenceMs).toBe(0);
    expect(report.review).toEqual({ visualQuality: "NOT_REVIEWED", captionAccuracy: "NOT_REVIEWED", sourceContentMapping: "NOT_VERIFIED" });
    expect(report.unmeasured).toContain("derivation_runtime");
    expect(text).not.toContain(directory);
    expect(text).not.toContain("private source");
    expect(text).not.toContain("private-sermon-title");
    expect(report.tools.ffprobe).toContain("ffprobe version");
    await expect(exec(process.execPath, args, commandOptions)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(text);

    await expect(measureLocalMedia({ sourceFile: "https://example.invalid/source.mp4",
      artifactFile: artifact, artifactId: "local-only", kind: "audio", sourceStartMs: 0, sourceEndMs: 1000 }))
      .rejects.toThrow(/local file path/);
    const playlist = path.join(directory, "not-media.m3u8");
    await writeFile(playlist, "#EXTM3U\n#EXTINF:1\nhttps://example.invalid/segment.ts\n");
    await expect(measureLocalMedia({ sourceFile: playlist, artifactFile: artifact,
      artifactId: "no-playlist", kind: "audio", sourceStartMs: 0, sourceEndMs: 1000 })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
