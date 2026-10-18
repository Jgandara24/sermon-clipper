import { describe, expect, it } from "vitest";
import { buildExportFfmpegArgs, buildExportFilterGraph } from "@/lib/export/render";
import type { FaceObservations } from "@/lib/speaker-tracking/faces";
import { applyLabRules } from "@/lib/speaker-tracking/lab-rules";
import { buildLabTrack, type ObservationFile } from "@/lib/speaker-tracking/lab-track";

const FPS = 30;

/** A 1280×720 clip at 30 fps where `faceAt(i)` gives the lone face box for frame i, or null. */
function clip(seconds: number, faceAt: (i: number) => { x: number; w: number } | null, start = 100): ObservationFile {
  const frames: FaceObservations["frames"] = [];
  for (let i = 0; i < seconds * FPS; i += 1) {
    const face = faceAt(i);
    frames.push({
      t: start + i / FPS,
      cut: false,
      faces: face ? [{ score: 0.92, box: { x: face.x, y: 120, w: face.w, h: face.w * 1.2 } }] : [],
    });
  }
  return {
    observations: { frames },
    geometry: { width: 1280, height: 720, rotation: 0, pixelAspect: "1:1", timebase: "1/15360" },
    source: "/lab/source.mp4",
    start,
    end: start + seconds,
    modelSha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    computeSeconds: 1,
  };
}

describe("applyLabRules", () => {
  it("bridges a lone face hidden for a moment instead of losing it", () => {
    // He looks down at his Bible for one second.
    const file = clip(4, (i) => (i >= 30 && i < 60 ? null : { x: 600, w: 60 }));
    const { observations, filledFrames } = applyLabRules(file.observations, 2);
    expect(filledFrames).toBe(30);
    expect(observations.frames.every((f) => f.faces.length === 1)).toBe(true);
  });

  it("does not bridge a gap longer than 4 seconds; it starts a new shot instead", () => {
    const file = clip(8, (i) => (i >= 30 && i < 30 + 5 * FPS ? null : { x: 600, w: 60 }));
    const { observations, filledFrames, addedCuts } = applyLabRules(file.observations, 2);
    expect(filledFrames).toBe(0);
    expect(addedCuts).toBe(1);
    expect(observations.frames[30 + 5 * FPS].cut).toBe(true);
  });

  it("marks a sudden jump in face size as a missed camera cut", () => {
    // Close shot (face 130 px) to wide shot (face 55 px) with the same background.
    const file = clip(2, (i) => (i < 30 ? { x: 560, w: 130 } : { x: 300, w: 55 }));
    const { observations, addedCuts } = applyLabRules(file.observations, 2);
    expect(addedCuts).toBe(1);
    expect(observations.frames[30].cut).toBe(true);
  });

  it("starts a clip that opens without a face from the first sighting within 2 seconds", () => {
    const file = clip(4, (i) => (i < 43 ? null : { x: 700, w: 60 }));
    const { observations } = applyLabRules(file.observations, 2);
    expect(observations.frames[0].faces).toHaveLength(1);
  });

  it("never fills or bridges frames when two faces are on screen", () => {
    const file = clip(3, (i) => (i < 30 ? { x: 600, w: 60 } : null));
    file.observations.frames[45].faces = [
      { score: 0.95, box: { x: 200, y: 100, w: 60, h: 72 } },
      { score: 0.95, box: { x: 900, y: 100, w: 60, h: 72 } },
    ];
    const { observations } = applyLabRules(file.observations, 2);
    expect(observations.frames[40].faces).toHaveLength(0);
  });

  it("works at Codex's tuned width: boxes are scaled down by the factor", () => {
    const file = clip(1, () => ({ x: 640, w: 64 }));
    const { observations } = applyLabRules(file.observations, 2);
    expect(observations.frames[0].faces[0].box.x).toBe(320);
    expect(observations.frames[0].faces[0].box.w).toBe(32);
  });
});

describe("buildLabTrack", () => {
  it("follows a preacher who walks across the stage and returns source-pixel commands", () => {
    // He walks from x=200 to x=1000 over 6 seconds in a wide shot.
    const file = clip(6, (i) => ({ x: 200 + (800 * i) / (6 * FPS), w: 60 }));
    const track = buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });

    expect(track.crop).toEqual({ w: 404, h: 720 });
    expect(track.followingPercent).toBeGreaterThan(95);
    const lines = track.commands.trim().split("\n");
    expect(lines).toHaveLength(6 * FPS);
    expect(lines[0]).toMatch(/^0\.000000 speaker x \d+, speaker y \d+;$/);
    const xs = lines.map((line) => Number(/speaker x (\d+)/.exec(line)![1]));
    expect(xs.at(-1)!).toBeGreaterThan(xs[0] + 400);
    expect(xs.every((x) => x % 2 === 0 && x >= 0 && x <= 1280 - 404)).toBe(true);
  });

  it("times commands from the render's seek point", () => {
    const file = clip(1, () => ({ x: 600, w: 60 }), 50.0167);
    const track = buildLabTrack(file, { seekSeconds: 50, rules: "lab-v1" });
    expect(track.commands.split("\n")[0]).toMatch(/^0\.016700 /);
  });
});

describe("export filter graph with a speaker track", () => {
  const track = { commandFilePath: "/tmp/work/speaker.cmd", crop: { w: 404, h: 720 }, first: { x: 438, y: 0 } };

  it("moves the crop with sendcmd instead of a fixed crop", () => {
    const graph = buildExportFilterGraph({ x: 438, y: 0, w: 404, h: 720 }, 1080, 1920, "/tmp/c.ass", track);
    expect(graph.startsWith("sendcmd=f='/tmp/work/speaker.cmd',crop@speaker=w=404:h=720:x=438:y=0,")).toBe(true);
    expect(graph).toContain("subtitles=filename='/tmp/c.ass'");
  });

  it("is unchanged without a track", () => {
    const graph = buildExportFilterGraph({ x: 438, y: 0, w: 404, h: 720 }, 1080, 1920, "/tmp/c.ass");
    expect(graph.startsWith("crop=404:720:438:0,")).toBe(true);
    expect(graph).not.toContain("sendcmd");
  });

  it("passes the track through buildExportFfmpegArgs", () => {
    const args = buildExportFfmpegArgs({
      sourceFilePath: "/tmp/s.mp4",
      range: { startMs: 50_000, endMs: 60_000 },
      cropPixels: { x: 438, y: 0, w: 404, h: 720 },
      assFilePath: "/tmp/c.ass",
      outputPath: "/tmp/o.mp4",
      outputWidth: 1080,
      outputHeight: 1920,
      speakerTrack: track,
    });
    expect(args[args.indexOf("-vf") + 1]).toContain("crop@speaker=w=404:h=720:x=438:y=0");
  });
});
