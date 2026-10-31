import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dropoutInClip, findAudioDropouts, parseSilenceDetect } from "@/lib/analysis/audio-dropout";

// Fix Q. Lab sermon 4f clip 2 (2026-10-21): the livestream lost its sound for 3.5 seconds at 51:56.5.
// Jake: "from seconds 8-11 there was no audio... we can't allows that to be posted."
const FOUR_F_C2 = { startMs: 3_108_058, endMs: 3_153_898 };
// ffmpeg's log for the whole service, scanned at -80 dB for 1 second or more.
const FOUR_F_LOG = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source-video':",
  "  Duration: 01:07:17.76, start: 0.000000, bitrate: 1093 kb/s",
  "[silencedetect @ 0x7fc958704380] silence_start: 3116.4867",
  "[silencedetect @ 0x7fc958704380] silence_end: 3119.9689 | silence_duration: 3.48219",
  "size=N/A time=01:07:17.76 bitrate=N/A speed= 201x",
].join("\n");

describe("parseSilenceDetect", () => {
  it("reads each silence ffmpeg reports, in milliseconds", () => {
    expect(parseSilenceDetect(FOUR_F_LOG)).toEqual([{ startMs: 3_116_487, endMs: 3_119_969 }]);
  });

  it("reads none from a service with no dropout", () => {
    expect(parseSilenceDetect("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source-video':\nsize=N/A time=01:12:01.10")).toEqual([]);
  });

  it("runs a silence that never ends to the end of the file", () => {
    expect(parseSilenceDetect("[silencedetect @ 0x1] silence_start: 12.5")).toEqual([{ startMs: 12_500, endMs: Infinity }]);
  });
});

describe("dropoutInClip", () => {
  const dropout = { startMs: 3_116_487, endMs: 3_119_969 };

  it("finds the dropout 8 to 12 seconds into lab sermon 4f clip 2", () => {
    expect(dropoutInClip(FOUR_F_C2, [dropout])).toEqual(dropout);
  });

  it("ignores a dropout outside the clip", () => {
    expect(dropoutInClip({ startMs: 3_120_500, endMs: 3_160_000 }, [dropout])).toBeNull();
    expect(dropoutInClip({ startMs: 3_060_000, endMs: 3_116_000 }, [dropout])).toBeNull();
  });

  it("ignores a dropout that silences less than 1 second of the clip", () => {
    expect(dropoutInClip({ startMs: 3_119_100, endMs: 3_160_000 }, [dropout])).toBeNull();
    expect(dropoutInClip({ startMs: 3_118_900, endMs: 3_160_000 }, [dropout])).toEqual(dropout);
  });
});

describe("findAudioDropouts (real ffmpeg)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "audio-dropout-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds digital silence of 1 second or more, and not a quiet room or a short gap", async () => {
    // 2 s of speech-level tone, 1.5 s of digital silence, 2 s tone, 0.5 s digital silence, 2 s tone,
    // 2 s of quiet room noise (about -50 dB), 1 s tone.
    const file = path.join(dir, "service.wav");
    const tone = (d: number) => `sine=frequency=220:sample_rate=48000:duration=${d}`;
    const silence = (d: number) => `anullsrc=r=48000:cl=mono:d=${d}`;
    const inputs = [tone(2), silence(1.5), tone(2), silence(0.5), tone(2), "anoisesrc=r=48000:a=0.003:d=2", tone(1)];
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      ...inputs.flatMap((source) => ["-f", "lavfi", "-i", source]),
      "-filter_complex", `${inputs.map((_, i) => `[${i}]aformat=channel_layouts=mono[a${i}]`).join(";")};${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${inputs.length}:v=0:a=1`,
      "-y", file,
    ]);
    const dropouts = await findAudioDropouts(file);
    expect(dropouts).toHaveLength(1);
    expect(dropouts[0].startMs).toBeGreaterThanOrEqual(1_950);
    expect(dropouts[0].startMs).toBeLessThanOrEqual(2_050);
    expect(dropouts[0].endMs).toBeGreaterThanOrEqual(3_450);
    expect(dropouts[0].endMs).toBeLessThanOrEqual(3_550);
  });
});
