/**
 * Phase 1 lab: build Codex's speaker-tracking crop path from face observations and render a
 * side-by-side preview (today's fixed center crop | the tracked crop).
 *
 *   node --import tsx scripts/lab/tracking/track-clip.ts --observations <json> --out <mp4> --label "Clip 1"
 *     [--configuration face-follow-smooth-v2|face-recovery-v1]
 *
 * The tracking rules are Codex's, unchanged (src/lib/speaker-tracking, copied from
 * codex/p4-sermon-understanding). Nothing is hand-fixed. Frames where the tracker gave up are
 * marked "HOLD" on the tracked side, so the judge can see where the machine alone falls short.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFaceTracking, type FaceObservations } from "@/lib/speaker-tracking/faces";
import { trackingCropAt } from "@/lib/speaker-tracking/path";
import type { TrackingRecord } from "@/lib/speaker-tracking/types";
import { readArgs } from "../lab-guard";

type ObservationFile = {
  observations: FaceObservations;
  geometry: TrackingRecord["geometry"];
  source: string;
  start: number;
  end: number;
  modelSha256: string;
  computeSeconds: number;
};

const FONT = path.resolve("public/fonts/DejaVuSans-Bold.ttf");

/** Codex tuned the motion limits (px/s, px/s²) on a 640×360 source; lab-v1 tracks at that width. */
const CODEX_TUNED_WIDTH = 640;
const MAX_BRIDGE_S = 4;
const MAX_EDGE_FILL_S = 2;
type Frame = FaceObservations["frames"][number];
type Box = Frame["faces"][number]["box"];

function faceJump(a: Box, b: Box) {
  const sizeRatio = Math.max(a.w, b.w) / Math.min(a.w, b.w);
  const centerMove = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
  return sizeRatio > 1.6 || centerMove > 2 * Math.max(a.w, b.w);
}

/**
 * lab-v1: three rules in front of Codex's unchanged tracker, for one-preacher sermon footage.
 * 1. A sudden jump in a lone face's size or position is a camera cut the frame-difference
 *    detector missed (Sunnylane's close and wide shots share one blue background).
 * 2. A lone face hidden for up to MAX_BRIDGE_S (looking down, turning) is bridged by linear
 *    interpolation between the last and next sighting. Offline processing knows both ends.
 *    A gap whose two ends differ like a cut becomes a cut instead.
 * 3. A clip that starts or ends without a face takes the nearest sighting within MAX_EDGE_FILL_S.
 * Frames with two or more faces are never filled or bridged, so no other person is substituted.
 */
function applyLabRules(input: FaceObservations, scale: number) {
  const frames: Frame[] = input.frames.map((f) => ({
    t: f.t,
    cut: f.cut,
    faces: f.faces.map((face) => ({
      score: face.score,
      box: { x: face.box.x / scale, y: face.box.y / scale, w: face.box.w / scale, h: face.box.h / scale },
    })),
  }));
  let addedCuts = 0;
  let filledFrames = 0;

  // Rule 1: missed cuts between consecutive single-face frames.
  let last: Box | undefined;
  for (const f of frames) {
    if (f.cut) last = undefined;
    if (f.faces.length === 1) {
      if (last && faceJump(last, f.faces[0].box) && !f.cut) {
        f.cut = true;
        addedCuts += 1;
      }
      last = f.faces[0].box;
    } else if (f.faces.length > 1) {
      last = undefined;
    }
  }

  // Rule 2: bridge gaps between lone-face sightings inside one shot.
  const single = (f: Frame) => f.faces.length === 1 && f.faces[0].score >= 0.9;
  for (let i = 0; i < frames.length; i += 1) {
    if (!single(frames[i]) || i + 1 >= frames.length || frames[i + 1].faces.length) continue;
    let j = i + 1;
    while (j < frames.length && frames[j].faces.length === 0 && !frames[j].cut) j += 1;
    if (j >= frames.length || frames[j].cut && frames[j].faces.length === 0) continue;
    if (!single(frames[j])) continue;
    const a = frames[i].faces[0].box;
    const b = frames[j].faces[0].box;
    if (frames[j].t - frames[i].t > MAX_BRIDGE_S || faceJump(a, b)) {
      if (!frames[j].cut) {
        frames[j].cut = true;
        addedCuts += 1;
      }
      continue;
    }
    for (let k = i + 1; k < j; k += 1) {
      const u = (frames[k].t - frames[i].t) / (frames[j].t - frames[i].t);
      const mix = (p: number, q: number) => p + (q - p) * u;
      frames[k].faces = [{ score: 0.9, box: { x: mix(a.x, b.x), y: mix(a.y, b.y), w: mix(a.w, b.w), h: mix(a.h, b.h) } }];
      filledFrames += 1;
    }
    i = j - 1;
  }

  // Rule 3: leading and trailing frames without a face.
  const fillEdge = (order: number[]) => {
    const firstSeen = order.find((k) => frames[k].faces.length > 0);
    if (firstSeen === undefined || !single(frames[firstSeen])) return;
    const box = frames[firstSeen].faces[0].box;
    for (const k of order) {
      if (k === firstSeen) break;
      if (Math.abs(frames[firstSeen].t - frames[k].t) > MAX_EDGE_FILL_S) continue;
      frames[k].faces = [{ score: 0.9, box: { ...box } }];
      filledFrames += 1;
    }
  };
  const indexes = frames.map((_, k) => k);
  fillEdge(indexes);
  fillEdge([...indexes].reverse());
  // A shot boundary can sit inside the filled lead-in; Codex's shot rule reads the first frame.
  if (frames[0].cut) frames[0].cut = false;

  return { observations: { frames }, addedCuts, filledFrames };
}
const PANEL_W = 540;
const PANEL_H = 960;

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function even(n: number) {
  return Math.floor(n / 2) * 2;
}

/** Merge review intervals that touch or nearly touch, so the summary is readable. */
function merge(intervals: { start: number; end: number; reason: string }[], gap = 0.3) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number; reasons: Set<string> }[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end + gap) {
      last.end = Math.max(last.end, i.end);
      last.reasons.add(i.reason);
    } else {
      out.push({ start: i.start, end: i.end, reasons: new Set([i.reason]) });
    }
  }
  return out;
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const obsPath = args.get("observations");
  const outPath = args.get("out");
  const label = String(args.get("label") ?? "clip");
  const configuration = String(args.get("configuration") ?? "face-follow-smooth-v2") as TrackingRecord["configuration"];
  const rules = String(args.get("rules") ?? "codex");
  if (typeof obsPath !== "string" || typeof outPath !== "string" || !["codex", "lab-v1"].includes(rules)) {
    console.error("Usage: track-clip.ts --observations <json> --out <mp4> [--label text] [--configuration ...] [--rules codex|lab-v1]");
    process.exit(2);
  }

  const raw = readFileSync(obsPath, "utf8");
  const file = JSON.parse(raw) as ObservationFile;
  // codex: Codex's tracker on the source pixels. lab-v1: the three lab rules, tracked at 640 wide.
  const scale = rules === "lab-v1" ? file.geometry.width / CODEX_TUNED_WIDTH : 1;
  const prepared = rules === "lab-v1" ? applyLabRules(file.observations, scale) : undefined;
  const observations = prepared?.observations ?? file.observations;
  const geometry = {
    ...file.geometry,
    width: Math.round(file.geometry.width / scale),
    height: Math.round(file.geometry.height / scale),
  };
  const { width, height } = geometry;
  const crop = { w: even(Math.min(width, (height * 9) / 16)), h: even(Math.min(height, (width * 16) / 9)) };
  const renderCrop = { w: even(crop.w * scale), h: even(crop.h * scale) };
  const observationsChecksum = sha256(JSON.stringify(observations));

  const base = {
    version: "speaker-v1" as const,
    mapping: "pixels-linear-v1" as const,
    workspaceId: "lab",
    sourceVideoId: "lab",
    sourceChecksum: sha256(file.source),
    geometry,
    start: file.start,
    end: file.end,
    aspect: "9:16" as const,
    detector: { kind: "yunet" as const, version: "yunet-2023mar", weightHashes: [file.modelSha256] },
    configuration,
    analysis: { jobId: sha256(`lab:${obsPath}`), attemptId: randomUUID(), observationsChecksum },
    availability: "available" as const,
    crop,
    bodyEvidence: "face-estimate" as const,
    requiredPictureReview: true as const,
  };

  const { record, review } = buildFaceTracking(base, observations);

  /** Crop position in source pixels, from the path built at the tracking scale. */
  const sourceCropAt = (t: number) => {
    const p = trackingCropAt(record, t);
    const x = Math.min(file.geometry.width - renderCrop.w, Math.max(0, even(p.x * scale)));
    const y = Math.min(file.geometry.height - renderCrop.h, Math.max(0, even(p.y * scale)));
    return { x, y };
  };

  // Per-frame commands, exactly as Codex's schedule.ts does, but with trackingCropAt directly.
  const frames = observations.frames;
  const commands = frames
    .map((frame) => {
      const p = sourceCropAt(frame.t);
      const at = Math.max(0, Math.floor((frame.t - file.start) * 1e6 + 1e-5) / 1e6);
      return `${at.toFixed(6)} speaker x ${p.x}, speaker y ${p.y};`;
    })
    .join("\n");

  // "Held" means the crop really stopped following: Codex marks those keys `hold`. Review flags
  // such as "framing" (the face-based body estimate is taller than the frame) do not stop the crop.
  const holdIntervals: { start: number; end: number; reason: string }[] = [];
  for (const shot of record.shots) {
    shot.keys.forEach((key, i) => {
      const next = shot.keys[i + 1];
      if (key.hold && next) holdIntervals.push({ start: key.t, end: next.t, reason: "hold" });
    });
  }
  const held = merge(holdIntervals, 0.05);
  const heldSeconds = held.reduce((sum, i) => sum + (i.end - i.start), 0);
  const reviewFlags = merge(record.unresolved).map((i) => ({
    start: Number((i.start - file.start).toFixed(2)),
    end: Number((i.end - file.start).toFixed(2)),
    reasons: [...i.reasons],
  }));
  const duration = file.end - file.start;
  const shots = record.shots.map((shot) => ({
    start: Number((shot.start - file.start).toFixed(2)),
    end: Number((shot.end - file.start).toFixed(2)),
    tracked: Boolean(shot.selectedSubject),
  }));

  const outDir = path.dirname(path.resolve(outPath));
  mkdirSync(outDir, { recursive: true });
  const stem = path.basename(outPath, ".mp4");
  const cmdFile = path.join(outDir, `${stem}.sendcmd.txt`);
  writeFileSync(cmdFile, commands + "\n");
  writeFileSync(path.join(outDir, `${stem}.tracking.json`), JSON.stringify({ record, review }, null, 1));

  const first = sourceCropAt(frames[0].t);
  // Only the longer holds are marked; one-frame blips are invisible in playback.
  const visibleHolds = held.filter((i) => i.end - i.start >= 0.3);
  const enableHold = visibleHolds.length
    ? visibleHolds
        .slice(0, 60)
        .map((i) => `between(t,${(i.start - file.start).toFixed(3)},${(i.end - file.start).toFixed(3)})`)
        .join("+")
    : "0";
  const text = (t: string) => t.replace(/[:\\']/g, (c) => `\\${c}`);
  const trackedTitle = rules === "lab-v1" ? "TRACKED (Codex + lab rules)" : "TRACKED (Codex as built)";
  const filter = [
    `[0:v]split=2[a][b]`,
    `[a]crop=${renderCrop.w}:${renderCrop.h}:(iw-${renderCrop.w})/2:(ih-${renderCrop.h})/2,scale=${PANEL_W}:${PANEL_H},` +
      `drawtext=fontfile=${FONT}:text='${text(`${label} - TODAY (fixed center)`)}':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6[l]`,
    `[b]sendcmd=f='${cmdFile}',crop@speaker=w=${renderCrop.w}:h=${renderCrop.h}:x=${first.x}:y=${first.y},scale=${PANEL_W}:${PANEL_H},` +
      `drawtext=fontfile=${FONT}:text='${text(`${label} - ${trackedTitle}`)}':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6,` +
      `drawtext=fontfile=${FONT}:text='HOLD - tracker gave up here':x=12:y=${PANEL_H - 52}:fontsize=26:fontcolor=white:box=1:boxcolor=red@0.75:enable='${enableHold}'[r]`,
    `[l][r]hstack=inputs=2[v]`,
  ].join(";");

  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-v", "error",
      "-ss", file.start.toFixed(6), "-i", file.source, "-t", duration.toFixed(3),
      "-filter_complex", filter, "-map", "[v]", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      path.resolve(outPath),
    ],
    { stdio: "inherit" },
  );

  const summary = {
    label,
    seconds: Number(duration.toFixed(2)),
    computeSeconds: file.computeSeconds,
    framesWithFaces: frames.filter((f) => f.faces.length).length,
    frames: frames.length,
    shots,
    trackedPercent: Number((100 * (1 - Math.min(heldSeconds, duration) / duration)).toFixed(1)),
    heldIntervals: held.map((i) => ({
      start: Number((i.start - file.start).toFixed(2)),
      end: Number((i.end - file.start).toFixed(2)),
      reasons: [...i.reasons],
    })),
    reviewFlags,
    configuration,
    rules,
    labRules: prepared ? { addedCuts: prepared.addedCuts, filledFrames: prepared.filledFrames } : undefined,
    output: path.resolve(outPath),
  };
  writeFileSync(path.join(outDir, `${stem}.summary.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
}

main();
