import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { labTrackingPython } from "@/lib/lab-flags";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import {
  cameraCheckPrompt,
  CameraFrameLabelsSchema,
  decideCameraCheck,
  groupNoFaceRuns,
  type CameraCheckResult,
  type CameraLabel,
  type CameraSample,
} from "./camera-check";

const SAMPLE_SCRIPT = path.resolve("scripts/lab/tracking/camera-sample.py");
/** Cheap and fast; the question is "slide or camera view". */
const CAMERA_CHECK_MODEL = "claude-haiku-4-5";
/** One request carries every faceless moment of a clip; cap it so a slide-heavy clip stays cheap. */
const MAX_FRAMES_PER_REQUEST = 12;

export type CameraCheckUsage = { inputTokens: number; outputTokens: number; frames: number };

/** Lab only. Samples one clip of a local source file and asks the vision model about faceless frames. */
export async function checkClipCamera(params: {
  sourceFilePath: string;
  startMs: number;
  endMs: number;
  workDir: string;
}): Promise<{ result: CameraCheckResult; usage: CameraCheckUsage }> {
  const outDir = path.join(params.workDir, `camera-${params.startMs}-${params.endMs}`);
  const { stdout } = await execFileWithTimeout(
    labTrackingPython(),
    [
      SAMPLE_SCRIPT,
      "--source", params.sourceFilePath,
      "--start", String(params.startMs / 1000),
      "--end", String(params.endMs / 1000),
      "--out-dir", outDir,
    ],
    { maxBuffer: 1024 * 1024 * 8, timeoutMs: envTimeoutMs("LAB_CAMERA_CHECK_TIMEOUT_MS", 5 * 60_000) },
  );
  const samples = (JSON.parse(stdout) as { samples: CameraSample[] }).samples;
  const runs = groupNoFaceRuns(samples);
  const usage: CameraCheckUsage = { inputTokens: 0, outputTokens: 0, frames: 0 };
  if (runs.length === 0) return { result: { pass: true }, usage };

  // The longest faceless moments first, so a cap never hides the longest slide.
  const shown = [...runs].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, MAX_FRAMES_PER_REQUEST);
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
  if (!parsed.success) return { result: { pass: false, reason: "unchecked", at: runs[0].start }, usage };

  const byIndex = new Map(parsed.data.frames.map((f) => [f.index, f.label]));
  const labels: CameraLabel[] = shown.map((_, i) => byIndex.get(i)).filter((l): l is CameraLabel => Boolean(l));
  return { result: decideCameraCheck(shown, labels), usage };
}
