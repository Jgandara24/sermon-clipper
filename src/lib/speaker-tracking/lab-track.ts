import { createHash, randomUUID } from "node:crypto";
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
  record: TrackingRecord;
};

const even = (n: number) => Math.floor(n / 2) * 2;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Builds Codex's speaker-tracking path ("face-follow-smooth-v2", unchanged) from face
 * observations, optionally behind the lab-v1 rules, and turns it into per-frame crop commands in
 * source pixels. Command times count from `seekSeconds`, the `-ss` value the render uses, which
 * is where ffmpeg restarts the clock (see buildExportFfmpegArgs).
 */
export function buildLabTrack(
  file: ObservationFile,
  options: { seekSeconds: number; rules: "codex" | "lab-v1" },
): LabTrack {
  const scale = options.rules === "lab-v1" ? file.geometry.width / CODEX_TUNED_WIDTH : 1;
  const prepared = options.rules === "lab-v1" ? applyLabRules(file.observations, scale) : undefined;
  const observations = prepared?.observations ?? file.observations;
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
      x: Math.min(file.geometry.width - renderCrop.w, Math.max(0, even(p.x * scale))),
      y: Math.min(file.geometry.height - renderCrop.h, Math.max(0, even(p.y * scale))),
    };
  };
  const commands = observations.frames
    .map((frame) => {
      const p = cropAt(frame.t);
      const at = Math.max(0, Math.floor((frame.t - options.seekSeconds) * 1e6 + 1e-5) / 1e6);
      return `${at.toFixed(6)} speaker x ${p.x}, speaker y ${p.y};`;
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
    record,
  };
}
