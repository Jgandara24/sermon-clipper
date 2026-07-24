import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, ffmpegPath as resolveFfmpegPath } from "@/lib/env";
import { execFileWithTimeout } from "@/lib/media/child-process";
import { classifyModel } from "./claude-provider";
import type { ExclusionRange } from "./outline/types";
import type { AnalysisModelCall } from "./usage";

/** Where the gate reads video frames from: a local file or a signed HTTP URL (ffmpeg seeks both). */
export type VideoSource = { kind: "path"; path: string } | { kind: "url"; url: string };

export type VisualGateStatus = "applied" | "skipped_disabled" | "skipped_unavailable";

export type VisualGateResult<T> = {
  /** Clips confirmed (possibly trimmed) to keep the preacher in frame, original order. */
  passed: T[];
  /** Rejections with the range recorded for SermonOutline.exclusions diagnostics. */
  rejected: Array<{ clip: T; exclusion: ExclusionRange }>;
  status: VisualGateStatus;
  calls: AnalysisModelCall[];
};

// Dense grid sampling (~4s) plus scene-change detection: an interval grid alone lets a camera
// cutaway hide between samples, so detected cuts add their own sample points. The cap bounds
// vision cost for the longest (90s) clips.
const FRAME_INTERVAL_MS = 4_000;
const MAX_FRAMES_PER_CLIP = 24;
// ffmpeg scene score above which a frame counts as a cut (0.3 is the conventional threshold
// for hard cuts; slow dissolves score lower but multi-camera sermon feeds cut hard).
const SCENE_CHANGE_THRESHOLD = 0.3;
// Sample this far after a detected cut so the frame shows the NEW shot, not the cut itself.
const POST_CUT_OFFSET_MS = 300;
const FRAME_TIMEOUT_MS = 30_000;
const SCENE_SCAN_TIMEOUT_MS = 120_000;
const VISION_MAX_TOKENS = 4000;

const FrameVerdictSchema = z.object({
  frames: z.array(
    z.object({
      index: z.number().int(),
      preacherVisible: z.boolean(),
    }),
  ),
});

/**
 * Whether the visual gate is enabled at all. `ANALYSIS_VISUAL_GATE=off` is honored ONLY outside
 * production — in production the gate is mandatory and analysis fails when it cannot run
 * (enforced in the ANALYZE handler via visualGateRequired).
 */
export function visualGateEnabled(): boolean {
  if (visualGateRequired()) return true;
  return (env.ANALYSIS_VISUAL_GATE || "on").toLowerCase() !== "off";
}

/** In production, clips must not ship without visual verification — no permissive skip. */
export function visualGateRequired(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Sample timestamps: just inside each edge, then evenly through the middle. */
export function frameTimestamps(startMs: number, endMs: number): number[] {
  const duration = endMs - startMs;
  const first = startMs + Math.min(500, duration / 4);
  const last = endMs - Math.min(500, duration / 4);
  const count = Math.min(MAX_FRAMES_PER_CLIP, Math.max(2, Math.floor(duration / FRAME_INTERVAL_MS) + 2));
  if (count <= 2) return [first, last];
  const step = (last - first) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(first + i * step));
}

/**
 * Merges the interval grid with scene-change sample points, deduplicating near-identical
 * timestamps. When the union exceeds the cap, scene-derived points win over grid points — a
 * detected cut is exactly where a cutaway hides — and the clip edges are always kept.
 */
export function mergeSampleTimestamps(
  grid: number[],
  scenePoints: number[],
  cap = MAX_FRAMES_PER_CLIP,
): number[] {
  const prioritized = [
    ...[grid[0], grid[grid.length - 1]].filter((t): t is number => t !== undefined),
    ...scenePoints,
    ...grid.slice(1, -1),
  ];
  const kept: number[] = [];
  for (const timestamp of prioritized) {
    if (kept.length >= cap) break;
    if (!kept.some((t) => Math.abs(t - timestamp) < 1_000)) kept.push(timestamp);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Detects hard cuts inside a clip via ffmpeg's scene filter and returns a sample timestamp just
 * after each cut. Any failure propagates — an unscanned clip is an unverified clip, and the
 * caller's per-clip fail-closed handling rejects it.
 */
async function detectSceneChangeTimestamps(
  video: VideoSource,
  startMs: number,
  endMs: number,
): Promise<number[]> {
  const input = video.kind === "path" ? video.path : video.url;
  const { stderr } = await execFileWithTimeout(
    resolveFfmpegPath(),
    [
      "-hide_banner",
      "-ss", (startMs / 1000).toFixed(3),
      "-t", ((endMs - startMs) / 1000).toFixed(3),
      "-i", input,
      "-an",
      "-vf", `select='gt(scene,${SCENE_CHANGE_THRESHOLD})',showinfo`,
      "-f", "null", "-",
    ],
    { timeoutMs: SCENE_SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const timestamps: number[] = [];
  for (const match of stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const cutMs = startMs + Math.round(Number(match[1]) * 1000) + POST_CUT_OFFSET_MS;
    if (cutMs < endMs) timestamps.push(cutMs);
  }
  return timestamps;
}

/**
 * Given per-frame visibility verdicts, trims a clip to its longest contiguous run of
 * preacher-visible frames, or rejects it (returns null) when no run is long enough. All-visible
 * passes untouched; the trim never widens the clip, so an eligible span stays eligible.
 */
export function trimToVisibleRun(
  clip: { startMs: number; endMs: number },
  frames: Array<{ timestampMs: number; visible: boolean }>,
  minMs: number,
): { startMs: number; endMs: number } | null {
  if (frames.length === 0) return null;
  if (frames.every((f) => f.visible)) return { startMs: clip.startMs, endMs: clip.endMs };

  let best: { from: number; to: number } | null = null;
  let runStart: number | null = null;
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].visible && runStart === null) runStart = i;
    const runEnds = !frames[i].visible || i === frames.length - 1;
    if (runStart !== null && runEnds) {
      const to = frames[i].visible ? i : i - 1;
      if (!best || to - runStart > best.to - best.from) best = { from: runStart, to };
      runStart = null;
    }
  }
  if (!best) return null;

  // Frame samples are points: keep the clip edge when the run touches it, otherwise cut at the
  // outermost confirmed-visible sample (conservative — never includes an unconfirmed edge).
  const startMs = best.from === 0 ? clip.startMs : frames[best.from].timestampMs;
  const endMs = best.to === frames.length - 1 ? clip.endMs : frames[best.to].timestampMs;
  if (endMs - startMs < minMs) return null;
  return { startMs, endMs };
}

async function extractFrame(
  video: VideoSource,
  timestampMs: number,
  outPath: string,
): Promise<void> {
  const input = video.kind === "path" ? video.path : video.url;
  // -ss before -i: fast seek (byte-range requests over HTTP for signed URLs), one frame,
  // downscaled hard — the model only needs to see whether a preacher is in frame.
  await execFileWithTimeout(
    resolveFfmpegPath(),
    ["-hide_banner", "-loglevel", "error", "-ss", (timestampMs / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "8", "-y", outPath],
    { timeoutMs: FRAME_TIMEOUT_MS },
  );
}

/**
 * The visual eligibility gate: samples frames across each candidate clip and asks a
 * vision-capable model whether the primary preacher is visibly in frame in each. Clips trim to
 * their longest confirmed-visible run or are rejected — per clip this fails CLOSED (an
 * extraction, scene-scan, or model error rejects that clip rather than shipping an unconfirmed
 * one). Gate-level infrastructure absence (no video source, no API client) skips the gate with
 * a `status` the caller must act on: the ANALYZE handler fails the job in production
 * (visualGateRequired) and only tolerates the skip in development/test environments.
 */
export async function applyVisualGate<T extends { startMs: number; endMs: number }>(
  clips: T[],
  video: VideoSource | null,
  options: { client: Anthropic | null; minMs: number; enabled: boolean },
): Promise<VisualGateResult<T>> {
  if (!options.enabled) {
    return { passed: clips, rejected: [], status: "skipped_disabled", calls: [] };
  }
  if (!video || !options.client) {
    return { passed: clips, rejected: [], status: "skipped_unavailable", calls: [] };
  }
  if (clips.length === 0) {
    return { passed: clips, rejected: [], status: "applied", calls: [] };
  }
  const client = options.client;

  const calls: AnalysisModelCall[] = [];
  const passed: T[] = [];
  const rejected: Array<{ clip: T; exclusion: ExclusionRange }> = [];
  const model = classifyModel();
  const workDir = await mkdtemp(path.join(tmpdir(), "sermon-visual-gate-"));

  try {
    for (const [clipIdx, clip] of clips.entries()) {
      try {
        // Interval grid + a sample just after every detected cut: a cutaway between grid
        // samples announces itself as a scene change, so it cannot hide in the gap.
        const scenePoints = await detectSceneChangeTimestamps(video, clip.startMs, clip.endMs);
        const timestamps = mergeSampleTimestamps(
          frameTimestamps(clip.startMs, clip.endMs),
          scenePoints,
        );
        const framePaths = timestamps.map((_, i) => path.join(workDir, `clip${clipIdx}-f${i}.jpg`));
        await Promise.all(
          timestamps.map((ts, i) => extractFrame(video, ts, framePaths[i])),
        );
        const images = await Promise.all(framePaths.map((p) => readFile(p)));

        const stream = client.messages.stream({
          model,
          max_tokens: VISION_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text" as const,
                  text:
                    `These frames are sampled in order from one candidate clip of a church ` +
                    `service video. The primary preacher is the person delivering the sermon. ` +
                    `For each frame, decide whether that preacher is clearly visible as the ` +
                    `shot's subject (not a worship band, congregation, baptistry, announcement ` +
                    `slide, or empty stage). When unsure, answer false.`,
                },
                ...images.flatMap((image, i) => [
                  { type: "text" as const, text: `Frame ${i}:` },
                  {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: "image/jpeg" as const,
                      data: image.toString("base64"),
                    },
                  },
                ]),
              ],
            },
          ],
          output_config: { format: zodOutputFormat(FrameVerdictSchema) },
        });
        const message = await stream.finalMessage();
        calls.push({
          model,
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        });

        let text = "";
        for (const block of message.content) {
          if (block.type === "text") text += block.text;
        }
        const verdicts = FrameVerdictSchema.parse(JSON.parse(text)).frames;
        const frames = timestamps.map((timestampMs, i) => ({
          timestampMs,
          visible: verdicts.find((v) => v.index === i)?.preacherVisible ?? false,
        }));

        const trimmed = trimToVisibleRun(clip, frames, options.minMs);
        if (trimmed) {
          passed.push({ ...clip, startMs: trimmed.startMs, endMs: trimmed.endMs });
        } else {
          rejected.push({
            clip,
            exclusion: { startMs: clip.startMs, endMs: clip.endMs, reason: "preacher_not_visible" },
          });
        }
      } catch {
        // Fail closed per clip: a frame we couldn't extract or judge is an unconfirmed frame,
        // and unconfirmed means rejected — never ship a clip the gate couldn't verify.
        rejected.push({
          clip,
          exclusion: { startMs: clip.startMs, endMs: clip.endMs, reason: "preacher_not_visible" },
        });
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return { passed, rejected, status: "applied", calls };
}
