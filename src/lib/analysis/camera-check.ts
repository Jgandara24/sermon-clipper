import { z } from "zod";

/**
 * Phase 1 lab camera check (docs/FOUNDER_BRIEF.md, quality test 3): a clip fails when the
 * church's video shows a full-screen slide (a verse, a sermon title, song words, a logo) instead
 * of the preacher for any part of it. Lab sermon 1b, 2026-10-17: two of six first picks were
 * mostly verse slides, and one showed the title slide "A Spirit of Servitude".
 *
 * Sampling finds the moments with no face; only those frames go to the vision model.
 *
 * Fix Y (lab sermon 4i clip 6, 2026-10-25): a "Christians Never Die" slide dissolved in for a quarter
 * of a second, 16 seconds in. At 2 samples a second both samples around it held the preacher's face
 * through the dissolve, so no frame went to the model. Jake: "There's a moment at 15 to 16 seconds
 * where the slide shows." The sampler now checks faces at 4 a second and reports scene changes, frames
 * that differ from the one before by 20 or more in mean gray level (this slide scored 58, camera-angle
 * cuts in lab sermon 2k scored 37, steady preaching stays under 5), and their frames go to the model
 * too. Over this round's 30 clips, 4 had such a frame: this slide and three camera cuts in 2k, which passed.
 */

export type CameraSample = { t: number; faceCount: number; image: string | null };
export type SceneChange = { t: number; score: number; image: string };
export type CameraRunVia = "no face" | "scene change" | "no person";
export type FacelessRun = { start: number; end: number; image: string; via: CameraRunVia };

export const CAMERA_LABELS = ["PREACHER_OR_STAGE", "SLIDE", "OTHER"] as const;
export type CameraLabel = (typeof CAMERA_LABELS)[number];

export const CameraFrameLabelsSchema = z.object({
  frames: z.array(z.object({ index: z.number().int(), label: z.enum(CAMERA_LABELS) })),
});

export type CameraCheckResult = { pass: true } | { pass: false; reason: "slide" | "unchecked" | "off-screen"; at: number; via?: CameraRunVia };

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
    if (middle.image) runs.push({ start: samples[i].t, end, image: middle.image, via: "no face" });
    i = j + 1;
  }
  return runs;
}

/** Fix Y: each scene change as a run one sample long, with its own frame. */
export function sceneChangeRuns(changes: SceneChange[], step: number): FacelessRun[] {
  return changes.map((change) => ({ start: change.t, end: change.t + step, image: change.image, via: "scene change" }));
}

/**
 * The runs to show the model, at most `max`: scene changes that fall outside every faceless run
 * first (they are few and short), then the faceless runs longest first, so a cap never hides the
 * longest slide.
 */
export function cameraRunsToShow(faceless: FacelessRun[], scene: FacelessRun[], max: number): FacelessRun[] {
  const outside = scene.filter((change) => !faceless.some((run) => change.start >= run.start && change.start < run.end));
  const longest = [...faceless].sort((a, b) => b.end - b.start - (a.end - a.start));
  return [...outside, ...longest].slice(0, max);
}

/** Fails on the first slide. Fails closed when the labels do not line up with the runs. */
export function decideCameraCheck(runs: FacelessRun[], labels: CameraLabel[]): CameraCheckResult {
  if (runs.length === 0) return { pass: true };
  if (labels.length !== runs.length) return { pass: false, reason: "unchecked", at: runs[0].start };
  const slide = runs.findIndex((_, i) => labels[i] === "SLIDE");
  return slide === -1 ? { pass: true } : { pass: false, reason: "slide", at: runs[slide].start, via: runs[slide].via };
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
    `A slide fading in or out over the camera view is still a SLIDE when its words fill the picture.\n` +
    `Return one entry per frame with its index and label.`
  );
}

/**
 * Fix AC (lab sermon 1q clip 4, 2026-10-26): the preacher walked out of the camera's own frame at the
 * right edge, nobody was in the picture from 8.5 s to 9.0 s, and the video dissolved to a second
 * camera. The vision model saw the stage and passed the frame, and the crop could follow nobody.
 * Jake: "the preacher walks out of the frame for too long around 7-9 second mark." After the slide
 * check passes, the person detector (YOLOX-s, the tracker's) runs on the faceless samples of every
 * run of EMPTY_FRAME_MIN_S or more, and a run of samples with no face and nobody seen that spans
 * EMPTY_FRAME_MIN_S or more rejects the clip as off-screen. The export's off-crop note (fix S) counts
 * such frames too.
 */
export const EMPTY_FRAME_MIN_S = 0.5;

/** The faceless runs long enough to hold an empty stretch; only their frames go to the person detector. */
export function runsToDetectPeople(samples: CameraSample[]): FacelessRun[] {
  return groupNoFaceRuns(samples).filter((run) => run.end - run.start >= EMPTY_FRAME_MIN_S - 1e-6);
}

/**
 * Consecutive samples with no face where the detector saw nobody, spanning EMPTY_FRAME_MIN_S or
 * more. `peopleSeen` gives the people in a sample's frame, or undefined when the detector did not
 * look at it; such a sample ends a run.
 */
export function emptyRuns(samples: CameraSample[], peopleSeen: (image: string) => number | undefined): { start: number; end: number }[] {
  const step = samples.length > 1 ? samples[1].t - samples[0].t : 0.25;
  const empty = (s: CameraSample) => s.faceCount === 0 && s.image !== null && peopleSeen(s.image) === 0;
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < samples.length) {
    if (!empty(samples[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && empty(samples[j + 1])) j += 1;
    const end = j + 1 < samples.length ? samples[j + 1].t : samples[j].t + step;
    if (end - samples[i].t >= EMPTY_FRAME_MIN_S - 1e-6) runs.push({ start: samples[i].t, end });
    i = j + 1;
  }
  return runs;
}

/** Fails on the first empty stretch. */
export function decideEmptyFrames(runs: { start: number; end: number }[]): CameraCheckResult {
  return runs.length === 0 ? { pass: true } : { pass: false, reason: "off-screen", at: runs[0].start, via: "no person" };
}
