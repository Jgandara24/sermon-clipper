import { describe, expect, it } from "vitest";
import { buildExportFfmpegArgs, buildExportFilterGraph } from "@/lib/export/render";
import type { FaceObservations } from "@/lib/speaker-tracking/faces";
import { applyLabRules } from "@/lib/speaker-tracking/lab-rules";
import { buildLabTrack, STILL_ZONE, type ObservationFile } from "@/lib/speaker-tracking/lab-track";

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

  it("does not bridge a gap longer than 4 seconds, and does not call it a camera cut", () => {
    // Jake, lab sermons 2 and 3: a made-up cut makes the crop jump. The center lock glides instead.
    const file = clip(8, (i) => (i >= 30 && i < 30 + 5 * FPS ? null : { x: 600, w: 60 }));
    const { observations, filledFrames, addedCuts } = applyLabRules(file.observations, 2);
    expect(filledFrames).toBe(0);
    expect(addedCuts).toBe(0);
    expect(observations.frames[30 + 5 * FPS].cut).toBe(false);
  });

  it("bridges a turn of up to 4 seconds even when he ends up across the stage", () => {
    // He turns away at 300 and his face comes back two seconds later at 900, the same size.
    const file = clip(4, (i) => (i < 30 ? { x: 300, w: 60 } : i < 90 ? null : { x: 900, w: 60 }));
    const { observations, filledFrames, addedCuts } = applyLabRules(file.observations, 2);
    expect(addedCuts).toBe(0);
    expect(filledFrames).toBe(60);
    expect(observations.frames[90].cut).toBe(false);
  });

  it("treats a gap whose two ends differ in face size as a missed camera cut", () => {
    // Close shot (face 130 px), one second without a face, then a wide shot (face 55 px).
    const file = clip(3, (i) => (i < 30 ? { x: 560, w: 130 } : i < 60 ? null : { x: 300, w: 55 }));
    const { observations, filledFrames, addedCuts } = applyLabRules(file.observations, 2);
    expect(addedCuts).toBe(1);
    expect(filledFrames).toBe(0);
    expect(observations.frames[60].cut).toBe(true);
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

/** Crop x per frame, from sendcmd lines. */
const cropXs = (commands: string) => commands.trim().split("\n").map((line) => Number(/speaker x (\d+)/.exec(line)![1]));

describe("buildLabTrack center lock", () => {
  // Jake, lab sermon 1c clips 1 and 3: "it must track him and keep him center at all times."
  it("keeps the face at the center of the frame while he walks across the stage", () => {
    const file = clip(6, (i) => ({ x: 200 + (800 * i) / (6 * FPS), w: 60 }));
    const track = buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });
    const xs = cropXs(track.commands);
    xs.forEach((x, i) => {
      const faceCenter = 200 + (800 * i) / (6 * FPS) + 30;
      expect(Math.abs(x + track.crop.w / 2 - faceCenter), `frame ${i}`).toBeLessThanOrEqual(6);
    });
  });

  it("does not shake when the detector's box jitters", () => {
    // He stands still; the face box wobbles ±6 px from frame to frame.
    const file = clip(4, (i) => ({ x: 600 + (i % 2 ? 6 : -6), w: 60 }));
    const xs = cropXs(buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" }).commands);
    const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
  });

  it("jumps straight to him at a camera cut instead of sliding across", () => {
    // Close shot centered at 630, then a wide shot where his face is at 300 and much smaller.
    const file = clip(2, (i) => (i < 30 ? { x: 560, w: 140 } : { x: 300, w: 50 }));
    const xs = cropXs(buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" }).commands);
    expect(Math.abs(xs[29] + 202 - 630)).toBeLessThanOrEqual(6);
    expect(Math.abs(xs[30] + 202 - 325)).toBeLessThanOrEqual(6);
  });

  it("glides to him over half a second when both detectors lost him, instead of jumping", () => {
    // Jake, lab sermons 2 and 3: "when it re-tracks him, it snaps back too quickly."
    // Face at 330, six seconds with no face and no person box, then his face at 930.
    const file = clip(9, (i) => (i < 30 ? { x: 300, w: 60 } : i < 210 ? null : { x: 900, w: 60 }));
    const track = buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });
    const centers = cropXs(track.commands).map((x) => x + track.crop.w / 2);
    const steps = centers.slice(1).map((c, i) => Math.abs(c - centers[i]));

    expect(Math.max(...steps)).toBeLessThanOrEqual(60);
    expect(Math.abs(centers[150] - 330)).toBeLessThanOrEqual(6);
    // Fix H blends a second time, so the glide starts a little earlier (frame 165, not 175).
    expect(Math.abs(centers[160] - 330)).toBeLessThanOrEqual(6);
    expect(Math.abs(centers[210] - 930)).toBeLessThanOrEqual(30);
    expect(Math.abs(centers[225] - 930)).toBeLessThanOrEqual(6);
  });

  it("follows his body through a turn when the observations carry person boxes", () => {
    // He turns away at 600 and walks to 900 over two seconds; the person detector sees him.
    const walk = (i: number) => (i < 30 ? 600 : i < 90 ? 600 + (300 * (i - 30)) / 60 : 900);
    const file = clip(4, (i) => (i >= 30 && i < 90 ? null : { x: walk(i) - 30, w: 60 }));
    file.people = {
      frames: Array.from({ length: 40 }, (_, k) => ({
        t: 100 + (3 * k) / FPS,
        people: [{ score: 0.92, box: { x: walk(3 * k) - 140, y: 60, w: 280, h: 640 } }],
      })),
    };
    const track = buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });
    const centers = cropXs(track.commands).map((x) => x + track.crop.w / 2);

    expect(track.bodyFilledFrames).toBe(60);
    expect(track.followingPercent).toBe(100);
    // 16 px: the smoothing and fix H's blend round the corner where he starts to walk (150 px/s);
    // 4% of the crop, half the still zone.
    centers.forEach((c, i) => expect(Math.abs(c - walk(i)), `frame ${i}`).toBeLessThanOrEqual(16));
  });

  it("holds still where no face is known and never leaves the source frame", () => {
    const file = clip(10, (i) => (i < 30 ? { x: 1200, w: 60 } : null));
    const track = buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });
    const xs = cropXs(track.commands);
    expect(new Set(xs.slice(30 + 2 * FPS)).size).toBe(1);
    expect(xs.every((x) => x >= 0 && x <= 1280 - track.crop.w)).toBe(true);
    expect(track.followingPercent).toBeLessThan(40);
  });
});

// Fix H. Lab sermons 1e and 2c (2026-10-18): four of Jake's five failures were "the
// stabilization/focus seems shaky/jittery" when the preacher moved side to side. Measured on 2c
// clip 5: the crop moved in 67% of all frames. A still zone keeps the crop at rest while his face
// stays near the center, then glides to center him again when he leaves it.
describe("buildLabTrack still zone (fix H)", () => {
  const centersOf = (track: ReturnType<typeof buildLabTrack>) => cropXs(track.commands).map((x) => x + track.crop.w / 2);

  it("keeps the crop at rest while he sways inside the still zone, and keeps him near the center", () => {
    // He shifts his weight: his face drifts 20 px each way, once a second.
    const face = (i: number) => 600 + 20 * Math.sin((2 * Math.PI * i) / FPS);
    const track = buildLabTrack(clip(4, (i) => ({ x: face(i) - 30, w: 60 })), { seekSeconds: 100, rules: "lab-v1" });
    const xs = cropXs(track.commands);
    expect(new Set(xs).size).toBe(1);
    centersOf(track).forEach((c, i) => expect(Math.abs(c - face(i)), `frame ${i}`).toBeLessThanOrEqual(STILL_ZONE * track.crop.w));
  });

  it("glides to center him again when he steps out of the still zone, and then rests", () => {
    // He stands at 600, takes two steps to 750 in half a second, and stands there.
    const face = (i: number) => (i < 60 ? 600 : i < 75 ? 600 + (150 * (i - 60)) / 15 : 750);
    const track = buildLabTrack(clip(5, (i) => ({ x: face(i) - 30, w: 60 })), { seekSeconds: 100, rules: "lab-v1" });
    const centers = centersOf(track);
    const steps = centers.slice(1).map((c, i) => Math.abs(c - centers[i]));

    expect(new Set(centers.slice(0, 45)).size).toBe(1);
    expect(Math.abs(centers[30] - 600)).toBeLessThanOrEqual(2);
    expect(Math.abs(centers[105] - 750)).toBeLessThanOrEqual(4);
    expect(new Set(centers.slice(110)).size).toBe(1);
    expect(Math.max(...steps)).toBeLessThanOrEqual(16);
    centers.forEach((c, i) => expect(Math.abs(c - face(i)), `frame ${i}`).toBeLessThanOrEqual(80));
  });

  it("holds through a moment when his arms are out and his face is turned away", () => {
    // Lab sermon 2c clip 5: arms out, face away; the box widens toward his arm and the crop followed.
    const file = clip(5, (i) => (i >= 30 && i < 120 ? null : { x: 570, w: 60 }));
    file.people = {
      frames: Array.from({ length: 50 }, (_, k) => ({
        t: 100 + (3 * k) / FPS,
        people: [{ score: 0.92, box: 3 * k >= 60 && 3 * k < 90 ? { x: 460, y: 60, w: 440, h: 640 } : { x: 460, y: 60, w: 280, h: 640 } }],
      })),
    };
    const centers = centersOf(buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" }));
    centers.forEach((c, i) => expect(Math.abs(c - 600), `frame ${i}`).toBeLessThanOrEqual(4));
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

// Fix S. Lab sermon 4g clip 4 (2026-10-22): the crop waited for him while he walked out of it for
// about 1 s. Jake: "We cannot have a pastor be off the screen for half a second or a second."
describe("buildLabTrack off-crop check (fix S)", () => {
  /** Face seen at 430 for one second, then lost; `later(i)` gives the person box centers from frame 30 on. */
  const lostAt430 = (later: (i: number) => number[]) => {
    const file = clip(4, (i) => (i < 30 ? { x: 400, w: 60 } : null));
    file.people = {
      frames: Array.from({ length: 40 }, (_, k) => ({
        t: 100 + (3 * k) / FPS,
        people: (3 * k < 30 ? [430] : later(3 * k)).map((x) => ({ score: 0.92, box: { x: x - 140, y: 60, w: 280, h: 640 } })),
      })),
    };
    return buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" });
  };

  it("notes a stretch of half a second or more where the person detector sees him outside the crop", () => {
    // The detector misses him for a second, then sees him at 1100 while the crop still waits at 430.
    const track = lostAt430((i) => (i < 60 ? [] : [1100]));
    expect(track.offCrop).toHaveLength(1);
    expect(track.offCrop![0].start).toBeCloseTo(2, 3);
    expect(track.offCrop![0].end).toBeCloseTo(4, 3);
  });

  it("notes nothing for a stretch shorter than half a second", () => {
    expect(lostAt430((i) => (i >= 60 && i < 72 ? [1100] : [])).offCrop).toEqual([]);
  });

  it("does not note a stretch where someone is inside the crop", () => {
    expect(lostAt430((i) => (i < 60 ? [] : [430, 1100])).offCrop).toEqual([]);
  });

  it("notes nothing while the crop follows him", () => {
    const walk = (i: number) => (i < 30 ? 600 : i < 90 ? 600 + (300 * (i - 30)) / 60 : 900);
    const file = clip(4, (i) => (i >= 30 && i < 90 ? null : { x: walk(i) - 30, w: 60 }));
    file.people = {
      frames: Array.from({ length: 40 }, (_, k) => ({
        t: 100 + (3 * k) / FPS,
        people: [{ score: 0.92, box: { x: walk(3 * k) - 140, y: 60, w: 280, h: 640 } }],
      })),
    };
    expect(buildLabTrack(file, { seekSeconds: 100, rules: "lab-v1" }).offCrop).toEqual([]);
  });
});
