import { createHash, randomUUID } from "node:crypto";
import { applyBodyFill, type PeopleObservations } from "./body-fill";
import { buildFaceTracking, type FaceObservations } from "./faces";
import { applyLabRules, CODEX_TUNED_WIDTH } from "./lab-rules";
import { trackingCropAt } from "./path";
import type { TrackingRecord } from "./types";

/** What scripts/lab/tracking/observe-faces.py writes. */
export type ObservationFile = {
  observations: FaceObservations;
  geometry: TrackingRecord["geometry"];
  source: string;
  start: number;
  end: number;
  modelSha256: string;
  computeSeconds: number;
  /** Person boxes every few frames, when the observer ran the person detector. */
  people?: PeopleObservations;
};

export type LabTrack = {
  /** ffmpeg sendcmd script, one line per decoded frame: `<s> speaker x <px>, speaker y <px>;`. */
  commands: string;
  /** Crop size in source pixels. */
  crop: { w: number; h: number };
  /** Crop position of the first frame, the crop filter's starting value. */
  first: { x: number; y: number };
  /** Share of the clip where the crop is following the face rather than holding still. */
  followingPercent: number;
  holds: { start: number; end: number }[];
  shots: { start: number; end: number; tracked: boolean }[];
  addedCuts: number;
  filledFrames: number;
  /** Frames without a lone face whose position came from the preacher's person box. */
  bodyFilledFrames: number;
  /** Fix S: stretches of OFF_CROP_MIN_S or more where the preacher is outside the crop, or (fix AC) nobody is in the frame. Center lock only. */
  offCrop?: { start: number; end: number }[];
  /** Codex's tracking record; only the "codex" motion builds one. */
  record?: TrackingRecord;
};

const even = (n: number) => Math.floor(n / 2) * 2;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Light, lag-free smoothing: removes detector jitter without letting the crop fall behind. */
const CENTER_LOCK_SIGMA_S = 0.2;
/** Where no detector sees him, the crop holds, then glides to his next position over this long. */
const GLIDE_S = 0.5;
/**
 * Fix H, the still zone (lab sermons 1e and 2c, 2026-10-18: "the stabilization/focus seems
 * shaky/jittery" when he moved side to side; on 2c clip 5 the crop moved in 67% of all frames).
 * The crop rests while his position stays within this share of the crop width of the rest's center
 * for at least MIN_REST_S; a slow walk (130 px a second) never fits, so walks are followed. Moves
 * into and out of a rest are blended over REST_BLEND_SIGMA_S, so re-centering is a glide.
 */
export const STILL_ZONE = 0.08;
const MIN_REST_S = 1;
const REST_BLEND_SIGMA_S = 0.3;

/** Zero-phase Gaussian with point-reflected padding, so a steady walk is followed exactly. */
function gaussian(values: number[], sigma: number): number[] {
  const n = values.length;
  if (n < 2 || sigma <= 0) return [...values];
  const radius = Math.ceil(3 * sigma);
  const at = (j: number) =>
    j < 0 ? 2 * values[0] - values[Math.min(n - 1, -j)] : j >= n ? 2 * values[n - 1] - values[Math.max(0, 2 * (n - 1) - j)] : values[j];
  return values.map((_, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += w * at(i + k);
      weight += w;
    }
    return sum / weight;
  });
}

/**
 * Rests the crop wherever his position stays within `zone` of the stretch's median for `minRest`
 * frames or more, at that median, so his face stays inside the still zone while the crop rests and
 * a stand that ends in a step stays centered on the stand. Elsewhere it follows him.
 */
function restInStillZone(centers: number[], zone: number, minRest: number): number[] {
  const out: number[] = new Array(centers.length);
  for (let i = 0; i < centers.length; ) {
    const sorted = [centers[i]];
    let j = i + 1;
    for (; j < centers.length; j += 1) {
      const at = sorted.findIndex((v) => v > centers[j]);
      const next = [...sorted];
      next.splice(at < 0 ? next.length : at, 0, centers[j]);
      const median = next[Math.floor(next.length / 2)];
      if (next[next.length - 1] - median > zone || median - next[0] > zone) break;
      sorted.splice(0, sorted.length, ...next);
    }
    if (j - i >= minRest) {
      out.fill(sorted[Math.floor(sorted.length / 2)], i, j);
      i = j;
    } else {
      out[i] = centers[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Fills unknown positions in one shot. Before his first sighting the crop waits where he appears;
 * after his last it holds. Between two sightings it holds, then eases to the next sighting over
 * `glideFrames` frames, so the crop never jumps inside a shot. The glide ends `leadFrames` before
 * he appears, so after smoothing the crop is already on him when he does.
 */
function holdAndGlide(shot: (number | null)[], glideFrames: number, leadFrames: number, fallback: number): number[] {
  const out: number[] = new Array(shot.length);
  let last: number | null = null;
  for (let i = 0; i < shot.length; ) {
    const known = shot[i];
    if (known !== null) {
      out[i] = last = known;
      i += 1;
      continue;
    }
    let j = i;
    while (j < shot.length && shot[j] === null) j += 1;
    const next = j < shot.length ? shot[j] : null;
    const lead = Math.min(leadFrames, Math.floor((j - i) / 3));
    const end = j - lead;
    const g = Math.min(end - i, glideFrames);
    for (let k = i; k < j; k += 1) {
      if (last === null || next === null) out[k] = last ?? next ?? fallback;
      else if (k < end - g) out[k] = last;
      else if (k >= end) out[k] = next;
      else {
        const u = (k - (end - g) + 1) / (g + 1);
        out[k] = last + (next - last) * u * u * (3 - 2 * u);
      }
    }
    i = j;
  }
  return out;
}

/**
 * Center lock (Jake, lab sermon 1c: "it must track him and keep him center at all times").
 * Offline, the face position is known for every frame, so the crop centers the lone face in every
 * frame. A zero-phase Gaussian, with point-reflected padding at shot edges so a steady walk is
 * followed exactly, takes out jitter. There is no speed limit. Then the still zone rests the crop
 * while he stands (restInStillZone), and a second, wider Gaussian blends each rest into the
 * following around it. Smoothing never crosses a camera cut, so at a cut the crop jumps straight to
 * him. Frames without a lone face hold and glide (holdAndGlide); a shot with no position at all
 * holds the frame's center.
 */
function centerLockXs(frames: FaceObservations["frames"], width: number, cropW: number) {
  const centers = frames.map((f) => (f.faces.length === 1 ? f.faces[0].box.x + f.faces[0].box.w / 2 : null));
  const xs: number[] = new Array(frames.length);
  const shotStarts = frames.map((f, i) => (i === 0 || f.cut ? i : -1)).filter((i) => i >= 0);
  shotStarts.forEach((start, s) => {
    const end = s + 1 < shotStarts.length ? shotStarts[s + 1] : frames.length;
    const dts = frames.slice(start + 1, end).map((f, i) => f.t - frames[start + i].t).sort((a, b) => a - b);
    const dt = dts.length ? dts[Math.floor(dts.length / 2)] : 1 / 30;
    const sigma = CENTER_LOCK_SIGMA_S / dt;
    // The glide ends early enough that, after both smoothings, the crop is on him when he appears.
    const lead = Math.round(Math.hypot(CENTER_LOCK_SIGMA_S, REST_BLEND_SIGMA_S) / dt);
    const filled = holdAndGlide(centers.slice(start, end), Math.round(GLIDE_S / dt), lead, width / 2);
    const rested = restInStillZone(gaussian(filled, sigma), STILL_ZONE * cropW, Math.round(MIN_REST_S / dt));
    gaussian(rested, REST_BLEND_SIGMA_S / dt).forEach((center, i) => {
      xs[start + i] = Math.max(0, Math.min(width - cropW, center - cropW / 2));
    });
  });
  return { xs, known: centers.map((c) => c !== null) };
}

/**
 * Fix S, the off-crop check (lab sermon 4g clip 4, 2026-10-22): the crop waited for him while he
 * walked out of it for about 1 s. Jake: "We cannot have a pastor be off the screen for half a second
 * or a second." A frame is off the crop only on evidence: his lone face (seen, or placed from his
 * body) is outside the crop, or, with no such face, the person detector sees people and none of
 * them is inside the crop. A frame with no evidence ends a stretch. The guesses of the lab rules
 * (bridges and edge fills) are not evidence. `frames` and `people` are in source pixels, `xs` in
 * tracking pixels.
 *
 * Fix AC (lab sermon 1q clip 4, 2026-10-26): the preacher walked out of the camera's own frame at the
 * right edge, nobody was in the picture for half a second, and the video dissolved to a second camera.
 * Jake: "the preacher walks out of the frame for too long around 7-9 second mark." With no face and no
 * person seen, those frames had no evidence and the check noted nothing. A frame where the person
 * detector ran and saw nobody, with no face seen, is an empty frame, and an empty frame is off the crop.
 */
export const OFF_CROP_MIN_S = 0.5;
/** A person sample this recent stands in for a frame; the observer samples every 0.1 s. */
const PEOPLE_SAMPLE_S = 0.15;

function offCropStretches(
  frames: FaceObservations["frames"],
  people: PeopleObservations | undefined,
  crop: { xs: number[]; w: number; scale: number },
  clipEnd: number,
) {
  const samples = people?.frames ?? [];
  let s = -1;
  const off = frames.map((f, i) => {
    const inside = (b: { x: number; w: number }) => {
      const center = (b.x + b.w / 2) / crop.scale;
      return center >= crop.xs[i] && center <= crop.xs[i] + crop.w;
    };
    if (f.faces.length === 1) return !inside(f.faces[0].box);
    while (s + 1 < samples.length && samples[s + 1].t <= f.t + 1e-6) s += 1;
    const sample = s >= 0 && f.t - samples[s].t <= PEOPLE_SAMPLE_S ? samples[s] : null;
    if (!sample) return false;
    // Fix AC: nobody in the frame at all, and no face, is an empty frame.
    if (sample.people.length === 0) return f.faces.length === 0;
    return !sample.people.some((p) => inside(p.box));
  });
  const stretches: { start: number; end: number }[] = [];
  for (let i = 0; i < frames.length; ) {
    let j = i;
    while (j < frames.length && off[j]) j += 1;
    const end = frames[j]?.t ?? clipEnd;
    if (j > i && end - frames[i].t >= OFF_CROP_MIN_S - 1e-6) stretches.push({ start: frames[i].t - frames[0].t, end: end - frames[0].t });
    i = Math.max(j, i + 1);
  }
  return stretches;
}

/**
 * Builds Codex's speaker-tracking path ("face-follow-smooth-v2", unchanged) from face
 * observations, optionally behind the lab-v1 rules, and turns it into per-frame crop commands in
 * source pixels. Command times count from `seekSeconds`, the `-ss` value the render uses, which
 * is where ffmpeg restarts the clock (see buildExportFfmpegArgs).
 */
export function buildLabTrack(
  file: ObservationFile,
  options: { seekSeconds: number; rules: "codex" | "lab-v1"; motion?: "center" | "codex" },
): LabTrack {
  const scale = options.rules === "lab-v1" ? file.geometry.width / CODEX_TUNED_WIDTH : 1;
  // Body fill runs first, in source pixels, so the lab rules see the filled turns as sightings.
  const bodyFilled =
    options.rules === "lab-v1" && file.people ? applyBodyFill(file.observations, file.people, file.geometry.width) : undefined;
  const prepared = options.rules === "lab-v1" ? applyLabRules(bodyFilled?.observations ?? file.observations, scale) : undefined;
  const observations = prepared?.observations ?? file.observations;
  const motion = options.motion ?? (options.rules === "lab-v1" ? "center" : "codex");
  const geometry = {
    ...file.geometry,
    width: Math.round(file.geometry.width / scale),
    height: Math.round(file.geometry.height / scale),
  };
  const crop = {
    w: even(Math.min(geometry.width, (geometry.height * 9) / 16)),
    h: even(Math.min(geometry.height, (geometry.width * 16) / 9)),
  };
  const renderCrop = { w: even(crop.w * scale), h: even(crop.h * scale) };
  // Rounded to a thousandth first: a smoothed rest is exactly constant, but floating-point sums can
  // land a hair under an even pixel and make one rest alternate between two crops.
  const toSource = (x: number) => Math.min(file.geometry.width - renderCrop.w, Math.max(0, even(Math.round(x * scale * 1000) / 1000)));
  const commandAt = (t: number, x: number, y: number) => {
    const at = Math.max(0, Math.floor((t - options.seekSeconds) * 1e6 + 1e-5) / 1e6);
    return `${at.toFixed(6)} speaker x ${x}, speaker y ${y};`;
  };

  if (motion === "center") {
    const { xs, known } = centerLockXs(observations.frames, geometry.width, crop.w);
    const y = Math.max(0, even((file.geometry.height - renderCrop.h) / 2));
    const start = observations.frames[0].t;
    const holds: { start: number; end: number }[] = [];
    observations.frames.forEach((f, i) => {
      if (known[i]) return;
      const next = observations.frames[i + 1]?.t ?? file.end;
      const last = holds.at(-1);
      if (last && f.t - start - last.end <= 0.05) last.end = next - start;
      else holds.push({ start: f.t - start, end: next - start });
    });
    const shotStarts = observations.frames.map((f, i) => (i === 0 || f.cut ? f.t - start : -1)).filter((t) => t >= 0);
    return {
      commands: observations.frames.map((f, i) => commandAt(f.t, toSource(xs[i]), y)).join("\n"),
      crop: renderCrop,
      first: { x: toSource(xs[0]), y },
      followingPercent: Number(((100 * known.filter(Boolean).length) / known.length).toFixed(1)),
      holds,
      shots: shotStarts.map((s, i) => ({ start: s, end: shotStarts[i + 1] ?? file.end - start, tracked: true })),
      addedCuts: prepared?.addedCuts ?? 0,
      filledFrames: prepared?.filledFrames ?? 0,
      bodyFilledFrames: bodyFilled?.bodyFilledFrames ?? 0,
      offCrop: offCropStretches((bodyFilled?.observations ?? file.observations).frames, file.people, { xs, w: crop.w, scale }, file.end),
    };
  }

  const { record } = buildFaceTracking(
    {
      version: "speaker-v1",
      mapping: "pixels-linear-v1",
      workspaceId: "lab",
      sourceVideoId: "lab",
      sourceChecksum: sha256(file.source),
      geometry,
      start: observations.frames[0].t,
      end: file.end,
      aspect: "9:16",
      detector: { kind: "yunet", version: "yunet-2023mar", weightHashes: [file.modelSha256] },
      configuration: "face-follow-smooth-v2",
      analysis: { jobId: sha256(`lab:${file.source}:${file.start}`), attemptId: randomUUID(), observationsChecksum: sha256(JSON.stringify(observations)) },
      availability: "available",
      crop,
      bodyEvidence: "face-estimate",
      requiredPictureReview: true,
    },
    observations,
  );

  const cropAt = (t: number) => {
    const p = trackingCropAt(record, t);
    return {
      x: toSource(p.x),
      y: Math.min(file.geometry.height - renderCrop.h, Math.max(0, even(p.y * scale))),
    };
  };
  const commands = observations.frames
    .map((frame) => {
      const p = cropAt(frame.t);
      return commandAt(frame.t, p.x, p.y);
    })
    .join("\n");

  // "Hold" keys are where Codex's tracker stopped following. Review flags such as "framing"
  // (the face-based body estimate is taller than the frame) do not stop the crop.
  const holds: { start: number; end: number }[] = [];
  for (const shot of record.shots) {
    shot.keys.forEach((key, i) => {
      const next = shot.keys[i + 1];
      if (!key.hold || !next) return;
      const lastHold = holds.at(-1);
      if (lastHold && key.t - lastHold.end <= 0.05) lastHold.end = next.t;
      else holds.push({ start: key.t, end: next.t });
    });
  }
  const duration = file.end - record.start;
  const heldSeconds = holds.reduce((sum, h) => sum + (h.end - h.start), 0);

  return {
    commands,
    crop: renderCrop,
    first: cropAt(observations.frames[0].t),
    followingPercent: Number((100 * (1 - Math.min(heldSeconds, duration) / duration)).toFixed(1)),
    holds: holds.map((h) => ({ start: h.start - record.start, end: h.end - record.start })),
    shots: record.shots.map((s) => ({ start: s.start - record.start, end: s.end - record.start, tracked: Boolean(s.selectedSubject) })),
    addedCuts: prepared?.addedCuts ?? 0,
    filledFrames: prepared?.filledFrames ?? 0,
    bodyFilledFrames: bodyFilled?.bodyFilledFrames ?? 0,
    record,
  };
}
