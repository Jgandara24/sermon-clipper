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
 * followed exactly, takes out jitter. There is no speed limit. Smoothing never crosses a camera
 * cut, so at a cut the crop jumps straight to him. Frames without a lone face hold and glide
 * (holdAndGlide); a shot with no position at all holds the frame's center.
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
    const filled = holdAndGlide(centers.slice(start, end), Math.round(GLIDE_S / dt), Math.round(sigma), width / 2);
    const n = filled.length;
    const radius = Math.ceil(3 * sigma);
    const at = (j: number) =>
      j < 0 ? 2 * filled[0] - filled[Math.min(n - 1, -j)] : j >= n ? 2 * filled[n - 1] - filled[Math.max(0, 2 * (n - 1) - j)] : filled[j];
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      let weight = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const w = Math.exp(-(k * k) / (2 * sigma * sigma));
        sum += w * at(i + k);
        weight += w;
      }
      const center = n > 1 ? sum / weight : filled[i];
      xs[start + i] = Math.max(0, Math.min(width - cropW, center - cropW / 2));
    }
  });
  return { xs, known: centers.map((c) => c !== null) };
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
  const toSource = (x: number) => Math.min(file.geometry.width - renderCrop.w, Math.max(0, even(x * scale)));
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
