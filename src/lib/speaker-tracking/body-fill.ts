import type { FaceObservations } from "./faces";

/**
 * Lab body fill (Jake, lab sermons 2 and 3, 2026-10-18: "track his body and shoulders"). The
 * face detector cannot see a face from the side or behind, so the crop held still while the
 * preacher turned and walked; six of seven failed clips were that. A person detector
 * (scripts/lab/tracking/observe-faces.py, YOLOX-s) sees him through the turn.
 *
 * Wherever there is no lone face, the face position is filled from the preacher's person box. The
 * preacher's box is the one that holds his lone face; between sightings it is followed by overlap,
 * forward from the last sighting and backward from the next, never across a camera cut. A shot
 * where his face never appears is not filled, so no other person is followed. Filled positions
 * keep the face's offset from the body center, blended from the offset before the gap to the one
 * after, so the path meets the real face at both ends. Boxes are in source pixels.
 */

type Box = FaceObservations["frames"][number]["faces"][number]["box"];
export type PeopleObservations = { frames: { t: number; people: { box: Box; score: number }[] }[] };

/** Least overlap (intersection over union) for a box to be the same person a sample later. */
const MIN_FOLLOW_IOU = 0.3;
/** A body sample this close to a frame stands in for it at the clip's edges. */
const EDGE_SAMPLE_S = 0.15;
/**
 * Fix H (lab sermon 2c clip 5, 2026-10-18): a box this much wider than his usual box in the shot
 * holds his outstretched arms, and its center swings toward them. Measured: 390 px wide standing,
 * 642 px with his arms out, 60 px of swing. Such a box keeps the chain going but gives no position.
 */
const ARMS_OUT_RATIO = 1.3;

const centerX = (b: Box) => b.x + b.w / 2;

function iou(a: Box, b: Box) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const inter = Math.max(0, w) * Math.max(0, h);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

export function applyBodyFill(input: FaceObservations, people: PeopleObservations, frameWidth = Infinity) {
  const frames = input.frames.map((f) => ({ ...f, faces: [...f.faces] }));
  const cutTimes = frames.filter((f, i) => i > 0 && f.cut).map((f) => f.t);
  const shotOf = (t: number) => cutTimes.filter((c) => c <= t + 1e-6).length;
  const frameAt = new Map(frames.map((f) => [f.t.toFixed(4), f]));

  // His box at each sample where his lone face is seen: the box holding the face center.
  const samples = people.frames;
  const anchors = samples.map((s) => {
    const frame = frameAt.get(s.t.toFixed(4));
    const face = frame?.faces.length === 1 ? frame.faces[0].box : null;
    if (!face) return null;
    const fx = centerX(face);
    const fy = face.y + face.h / 2;
    const holders = s.people.filter(
      (p) => fx > p.box.x && fx < p.box.x + p.box.w && fy > p.box.y - face.h && fy < p.box.y + p.box.h / 2,
    );
    holders.sort((a, b) => Math.abs(centerX(a.box) - fx) - Math.abs(centerX(b.box) - fx));
    return holders[0]?.box ?? null;
  });

  const follow = (order: number[]) => {
    const chosen: (Box | null)[] = new Array(samples.length).fill(null);
    let previous: Box | null = null;
    let previousShot = -1;
    for (const k of order) {
      const shot = shotOf(samples[k].t);
      if (shot !== previousShot) previous = null;
      previousShot = shot;
      if (anchors[k]) previous = anchors[k];
      else if (previous) {
        const last: Box = previous;
        const best = samples[k].people
          .map((p) => ({ box: p.box, overlap: iou(p.box, last) }))
          .sort((a, b) => b.overlap - a.overlap)[0];
        previous = best && best.overlap >= MIN_FOLLOW_IOU ? best.box : null;
      }
      chosen[k] = previous;
    }
    return chosen;
  };
  const order = samples.map((_, k) => k);
  const forward = follow(order);
  const backward = follow([...order].reverse());
  const chosen = samples.map((s, k) => ({ t: s.t, shot: shotOf(s.t), box: forward[k] ?? backward[k] }));
  const usualWidth = new Map<number, number>();
  for (const shot of new Set(chosen.map((b) => b.shot))) {
    const widths = chosen.filter((b) => b.shot === shot && b.box).map((b) => b.box!.w).sort((a, b) => a - b);
    if (widths.length) usualWidth.set(shot, widths[Math.floor(widths.length / 2)]);
  }
  const body = chosen.map((b) => ({ ...b, box: b.box && b.box.w > ARMS_OUT_RATIO * usualWidth.get(b.shot)! ? null : b.box }));

  // His body center at a frame time: between the two samples around it, both his and in its shot.
  const bodyAt = (t: number): number | null => {
    const shot = shotOf(t);
    const after = body.findIndex((b) => b.t >= t - 1e-6);
    const at = after >= 0 ? body[after] : null;
    if (at && Math.abs(at.t - t) < 1e-6) return at.box && at.shot === shot ? centerX(at.box) : null;
    const before = after > 0 ? body[after - 1] : after < 0 ? body.at(-1) : null;
    const usable = (b: (typeof body)[number] | null | undefined) => (b && b.box && b.shot === shot ? b : null);
    const a = usable(before);
    const b = usable(at);
    if (a && b) return centerX(a.box!) + ((centerX(b.box!) - centerX(a.box!)) * (t - a.t)) / (b.t - a.t);
    // At the clip's edges, past the first or last sample.
    const edge = !at ? a : !before ? b : null;
    return edge && Math.abs(edge.t - t) <= EDGE_SAMPLE_S ? centerX(edge.box!) : null;
  };

  let bodyFilledFrames = 0;
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].faces.length === 1) continue;
    // A run of frames without a lone face, inside one shot.
    let j = i + 1;
    while (j < frames.length && frames[j].faces.length !== 1 && !frames[j].cut) j += 1;
    const before = i > 0 && !frames[i].cut ? frames[i - 1] : null;
    const after = j < frames.length && !frames[j].cut ? frames[j] : null;
    const offsetAt = (f: (typeof frames)[number] | null) => {
      const b = f ? bodyAt(f.t) : null;
      return f && b !== null ? centerX(f.faces[0].box) - b : null;
    };
    const startOffset = offsetAt(before);
    const endOffset = offsetAt(after);
    const reference = (before ?? after)?.faces[0]?.box;
    for (let k = i; k < j; k += 1) {
      if (frames[k].faces.length > 1) continue;
      const center = bodyAt(frames[k].t);
      if (center === null) continue;
      const u = j - i > 1 ? (k - i) / (j - i - 1) : 0.5;
      const offset =
        startOffset !== null && endOffset !== null
          ? startOffset + (endOffset - startOffset) * u
          : (startOffset ?? endOffset ?? 0);
      const w = reference?.w ?? 60;
      const x = Math.max(0, Math.min(frameWidth - w, center + offset - w / 2));
      frames[k].faces = [{ score: 0.95, box: { x, y: reference?.y ?? 0, w, h: reference?.h ?? w * 1.2 } }];
      bodyFilledFrames += 1;
    }
    i = j - 1;
  }

  return { observations: { frames }, bodyFilledFrames };
}
