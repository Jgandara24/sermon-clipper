import type { FaceObservations } from "./faces";

/**
 * Phase 1 lab rules ("lab-v1") that sit in front of Codex's unchanged tracker (faces.ts,
 * motion.ts). Measured on lab sermon 1b, 2026-10-17: Codex's tracker as built followed the
 * preacher 0–86% of each clip; with these rules, 84–100% outside slides.
 */

/** Codex tuned the motion limits (px/s, px/s²) on a 640×360 source; lab-v1 tracks at that width. */
export const CODEX_TUNED_WIDTH = 640;
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
 * 1. A sudden jump in a lone face's size or position is a camera cut the frame-difference
 *    detector missed (Sunnylane's close and wide shots share one blue background).
 * 2. A lone face hidden for up to MAX_BRIDGE_S (looking down, turning) is bridged by linear
 *    interpolation between the last and next sighting. Offline processing knows both ends.
 *    A gap whose two ends differ like a cut, or that runs longer, becomes a cut instead.
 * 3. A clip that starts or ends without a face takes the nearest sighting within MAX_EDGE_FILL_S.
 * Frames with two or more faces are never filled or bridged, so no other person is substituted.
 * Boxes are divided by `scale` so the tracker runs at Codex's tuned width.
 */
export function applyLabRules(input: FaceObservations, scale: number) {
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
    if (j >= frames.length || (frames[j].cut && frames[j].faces.length === 0)) continue;
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
  // Codex's shot rule reads a shot's first frames; the clip's first frame never opens a new shot.
  if (frames[0].cut) frames[0].cut = false;

  return { observations: { frames }, addedCuts, filledFrames };
}
