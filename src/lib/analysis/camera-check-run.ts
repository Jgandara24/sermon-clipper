import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import {
  cameraCheckPrompt,
  CameraFrameLabelsSchema,
  cameraRunsToShow,
  decideCameraCheck,
  decideEmptyFrames,
  emptyRuns,
  groupNoFaceRuns,
  runsToDetectPeople,
  sceneChangeRuns,
  type CameraCheckResult,
  type CameraLabel,
  type CameraSample,
  type SceneChange,
} from "./camera-check";

const SAMPLE_SCRIPT = path.resolve("scripts/lab/tracking/camera-sample.py");
/** Fix AC: the person detector, on the faceless sample frames of the longer runs. */
const PEOPLE_SCRIPT = path.resolve("scripts/lab/tracking/observe-people.py");
/** Cheap and fast; the question is "slide or camera view". */
const CAMERA_CHECK_MODEL = "claude-haiku-4-5";
/** One request carries every faceless moment of a clip; cap it so a slide-heavy clip stays cheap. */
const MAX_FRAMES_PER_REQUEST = 12;

export type CameraCheckUsage = { inputTokens: number; outputTokens: number; frames: number; sceneFrames: number };

/** `python` is the detector Python (DETECTOR_PYTHON), resolved by the caller once per job. */
type ClipParams = { python: string; sourceFilePath: string; startMs: number; endMs: number; workDir: string };

/** Samples one clip of a local source file: face counts at 4 a second, and scene changes (fix Y). */
async function sampleClip(params: ClipParams): Promise<{ samples: CameraSample[]; sceneChanges: SceneChange[] }> {
  const outDir = path.join(params.workDir, `camera-${params.startMs}-${params.endMs}`);
  const { stdout } = await execFileWithTimeout(
    params.python,
    [
      SAMPLE_SCRIPT,
      "--source", params.sourceFilePath,
      "--start", String(params.startMs / 1000),
      "--end", String(params.endMs / 1000),
      "--out-dir", outDir,
    ],
    { maxBuffer: 1024 * 1024 * 8, timeoutMs: envTimeoutMs("LAB_CAMERA_CHECK_TIMEOUT_MS", 5 * 60_000) },
  );
  const { samples, sceneChanges = [] } = JSON.parse(stdout) as { samples: CameraSample[]; sceneChanges?: SceneChange[] };
  return { samples, sceneChanges };
}

/** Fix AC: how many people the detector sees in each faceless frame of the longer no-face runs, by image path. */
async function detectPeople(python: string, samples: CameraSample[]): Promise<Map<string, number>> {
  const images = new Set<string>();
  for (const run of runsToDetectPeople(samples)) {
    for (const sample of samples) {
      if (sample.faceCount === 0 && sample.image && sample.t >= run.start && sample.t < run.end) images.add(sample.image);
    }
  }
  const seen = new Map<string, number>();
  if (images.size === 0) return seen;
  const { stdout } = await execFileWithTimeout(python, [PEOPLE_SCRIPT, "--images", ...images], {
    maxBuffer: 1024 * 1024 * 8,
    timeoutMs: envTimeoutMs("LAB_CAMERA_CHECK_TIMEOUT_MS", 5 * 60_000),
  });
  const { people } = JSON.parse(stdout) as { people: Record<string, unknown[]> };
  for (const [image, boxes] of Object.entries(people)) seen.set(image, boxes.length);
  return seen;
}

/** Fix AC on its own: the empty stretches of one clip, without the vision model (the lab's replay gate). */
export async function checkClipEmptyFrames(params: ClipParams): Promise<{ result: CameraCheckResult; runs: { start: number; end: number }[]; samples: number; framesChecked: number }> {
  const { samples } = await sampleClip(params);
  const seen = await detectPeople(params.python, samples);
  const runs = emptyRuns(samples, (image) => seen.get(image));
  return { result: decideEmptyFrames(runs), runs, samples: samples.length, framesChecked: seen.size };
}

/**
 * The camera check. Samples one clip of a local source file and asks the vision model about faceless frames
 * and scene changes (fix Y). When no slide is found, the person detector reads the longer faceless
 * runs, and an empty stretch rejects the clip as off-screen (fix AC).
 */
export async function checkClipCamera(params: ClipParams): Promise<{ result: CameraCheckResult; usage: CameraCheckUsage }> {
  const { samples, sceneChanges } = await sampleClip(params);
  const step = samples.length > 1 ? samples[1].t - samples[0].t : 0.25;
  const faceless = groupNoFaceRuns(samples);
  const shown = cameraRunsToShow(faceless, sceneChangeRuns(sceneChanges, step), MAX_FRAMES_PER_REQUEST);
  const usage: CameraCheckUsage = { inputTokens: 0, outputTokens: 0, frames: 0, sceneFrames: shown.filter((run) => run.via === "scene change").length };
  if (shown.length === 0) return { result: { pass: true }, usage };
  const content: Anthropic.ContentBlockParam[] = [];
  for (const [index, run] of shown.entries()) {
    content.push({ type: "text", text: `Frame ${index}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: (await readFile(run.image)).toString("base64") },
    });
  }
  content.push({ type: "text", text: cameraCheckPrompt(shown.length) });

  const message = await new Anthropic().messages.create({
    model: CAMERA_CHECK_MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(CameraFrameLabelsSchema) },
  });
  usage.inputTokens = message.usage.input_tokens;
  usage.outputTokens = message.usage.output_tokens;
  usage.frames = shown.length;
  const block = message.content.find((b) => b.type === "text");
  const parsed = CameraFrameLabelsSchema.safeParse(block && block.type === "text" ? JSON.parse(block.text) : null);
  if (!parsed.success) return { result: { pass: false, reason: "unchecked", at: shown[0].start }, usage };

  const byIndex = new Map(parsed.data.frames.map((f) => [f.index, f.label]));
  const labels: CameraLabel[] = shown.map((_, i) => byIndex.get(i)).filter((l): l is CameraLabel => Boolean(l));
  const decided = decideCameraCheck(shown, labels);
  if (!decided.pass) return { result: decided, usage };
  // Fix AC: no slide, so the faceless frames may still be empty.
  const seen = await detectPeople(params.python, samples);
  return { result: decideEmptyFrames(emptyRuns(samples, (image) => seen.get(image))), usage };
}
