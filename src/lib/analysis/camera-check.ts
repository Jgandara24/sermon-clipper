import { z } from "zod";

/**
 * Phase 1 lab camera check (docs/FOUNDER_BRIEF.md, quality test 3): a clip fails when the
 * church's video shows a full-screen slide (a verse, a sermon title, song words, a logo) instead
 * of the preacher for any part of it. Lab sermon 1b, 2026-10-17: two of six first picks were
 * mostly verse slides, and one showed the title slide "A Spirit of Servitude".
 *
 * Sampling finds the moments with no face; only those frames go to the vision model.
 */

export type CameraSample = { t: number; faceCount: number; image: string | null };
export type FacelessRun = { start: number; end: number; image: string };

export const CAMERA_LABELS = ["PREACHER_OR_STAGE", "SLIDE", "OTHER"] as const;
export type CameraLabel = (typeof CAMERA_LABELS)[number];

export const CameraFrameLabelsSchema = z.object({
  frames: z.array(z.object({ index: z.number().int(), label: z.enum(CAMERA_LABELS) })),
});

export type CameraCheckResult = { pass: true } | { pass: false; reason: "slide" | "unchecked"; at: number };

/** Consecutive samples with no face, each with the middle frame to show the vision model. */
export function groupNoFaceRuns(samples: CameraSample[]): FacelessRun[] {
  const runs: FacelessRun[] = [];
  const step = samples.length > 1 ? samples[1].t - samples[0].t : 0.5;
  let i = 0;
  while (i < samples.length) {
    if (samples[i].faceCount !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && samples[j + 1].faceCount === 0) j += 1;
    const middle = samples[i + Math.floor((j - i + 1) / 2)];
    const end = j + 1 < samples.length ? samples[j + 1].t : samples[j].t + step;
    if (middle.image) runs.push({ start: samples[i].t, end, image: middle.image });
    i = j + 1;
  }
  return runs;
}

/** Fails on the first slide. Fails closed when the labels do not line up with the runs. */
export function decideCameraCheck(runs: FacelessRun[], labels: CameraLabel[]): CameraCheckResult {
  if (runs.length === 0) return { pass: true };
  if (labels.length !== runs.length) return { pass: false, reason: "unchecked", at: runs[0].start };
  const slide = runs.findIndex((_, i) => labels[i] === "SLIDE");
  return slide === -1 ? { pass: true } : { pass: false, reason: "slide", at: runs[slide].start };
}

export function cameraCheckPrompt(frameCount: number): string {
  return (
    `These ${frameCount} frames are numbered from 0 and come from a church service video. ` +
    `Label each frame with exactly one label:\n` +
    `- PREACHER_OR_STAGE: the camera shows a person preaching, or the stage or pulpit, as the main picture ` +
    `(even if the person is turned away, small, or partly hidden).\n` +
    `- SLIDE: a full-screen graphic fills the picture instead of a camera view: a Bible verse, a sermon or ` +
    `series title, song lyrics or song words, a logo, an announcement graphic, or mostly text on a plain background.\n` +
    `- OTHER: anything else, such as the audience, the band, an empty or black frame, or a blurred transition.\n` +
    `Return one entry per frame with its index and label.`
  );
}
