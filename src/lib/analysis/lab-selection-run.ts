import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PrismaClient } from "@prisma/client";
import { labStepEnabled } from "@/lib/lab-flags";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { getStorageProvider } from "@/lib/storage";
import { boundaryContext, BoundaryChoiceSchema, chooseBoundary } from "./boundary-step";
import { checkClipCamera } from "./camera-check-run";
import { scoringModel } from "./claude-provider";
import { applyLabSelectionSteps } from "./lab-selection";
import { findSermonSpan, SermonSpanSchema, type SermonSpan } from "./sermon-span";

type LabClip = { startMs: number; endMs: number; text: string; total: number; title: string };
type Segment = { idx: number; startMs: number; endMs: number; text: string };

/**
 * Lab only. Runs the sermon span, the boundary step and the camera check (whichever flags are on) on ANALYZE's
 * ranked clips and records what each did as one operational event. Not cost-metered: the lab
 * records token counts in the event instead.
 */
export async function runLabSelection<T extends LabClip>(params: {
  prisma: PrismaClient;
  workspaceId: string;
  projectId: string;
  jobId: string;
  sourceStorageKey: string | null;
  ranked: T[];
  segments: Segment[];
  targetCount: number;
}): Promise<T[]> {
  const boundaryOn = labStepEnabled("boundaryStep");
  const cameraOn = labStepEnabled("cameraCheck") && Boolean(params.sourceStorageKey);
  const spanOn = labStepEnabled("sermonSpan");
  if (!boundaryOn && !cameraOn && !spanOn) return params.ranked;

  const startedAt = Date.now();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "lab-selection-"));
  const usage = { spanInput: 0, spanOutput: 0, boundaryInput: 0, boundaryOutput: 0, cameraInput: 0, cameraOutput: 0, cameraFrames: 0 };
  const boundaryLog: {
    title: string;
    from: [number, number];
    to: [number, number] | null;
    adjustedForScripture?: boolean;
    adjustedEnd?: boolean;
    reason?: string;
    attempts?: { startUnit: number; endUnit: number; refused: string | null; question?: string }[];
    error?: string;
  }[] = [];
  const cameraLog: { title: string; result: string; at?: number; error?: string }[] = [];
  let spanLog: { firstLine?: number; lastLine?: number; reason?: string; lines?: number; span?: SermonSpan | null; error?: string } | null = null;

  try {
    let sourceFilePath: string | null = null;
    if (cameraOn) {
      sourceFilePath = path.join(workDir, "source-video");
      await getStorageProvider().downloadToFile(params.sourceStorageKey!, sourceFilePath);
    }

    let span: SermonSpan | null = null;
    if (spanOn) {
      try {
        const found = await findSermonSpan(params.segments, async (prompt) => {
          const message = await new Anthropic().messages.create({
            model: scoringModel(),
            max_tokens: 1000,
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: prompt }],
            output_config: { format: zodOutputFormat(SermonSpanSchema) },
          });
          usage.spanInput += message.usage.input_tokens;
          usage.spanOutput += message.usage.output_tokens;
          const block = message.content.find((b) => b.type === "text");
          return SermonSpanSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
        });
        span = found.span;
        spanLog = { ...found.answer, lines: found.lines, span };
      } catch (error) {
        // Fails open: without a span the lab keeps every clip, as before fix J.
        spanLog = { error: String(error) };
      }
    }
    // The boundary step reads only sermon sentences, so it cannot move a clip outside the sermon.
    const sermonSegments = span ? params.segments.filter((s) => s.startMs >= span!.startMs && s.endMs <= span!.endMs) : params.segments;

    const boundary = boundaryOn
      ? async (clip: T) => {
          const context = boundaryContext(sermonSegments, clip);
          try {
            const { range, attempts } = await chooseBoundary(context, async (turns) => {
              // Thinking off, as Stage B does: on a long prompt the model otherwise spends the
              // whole token budget thinking and returns no answer.
              const message = await new Anthropic().messages.create({
                model: scoringModel(),
                max_tokens: 1000,
                thinking: { type: "disabled" },
                messages: turns,
                output_config: { format: zodOutputFormat(BoundaryChoiceSchema) },
              });
              usage.boundaryInput += message.usage.input_tokens;
              usage.boundaryOutput += message.usage.output_tokens;
              const block = message.content.find((b) => b.type === "text");
              return BoundaryChoiceSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
            });
            boundaryLog.push({
              title: clip.title,
              from: [clip.startMs, clip.endMs],
              to: range ? [range.startMs, range.endMs] : null,
              adjustedForScripture: range?.adjustedForScripture,
              adjustedEnd: range?.adjustedEnd,
              reason: attempts.at(-1)?.reason,
              attempts: attempts.map(({ startUnit, endUnit, refused, question }) => ({ startUnit, endUnit, refused, question })),
            });
            return range && { startMs: range.startMs, endMs: range.endMs };
          } catch (error) {
            boundaryLog.push({ title: clip.title, from: [clip.startMs, clip.endMs], to: null, error: String(error) });
            return null;
          }
        }
      : null;

    const cameraCheck = cameraOn
      ? async (clip: T) => {
          try {
            const { result, usage: used } = await checkClipCamera({
              sourceFilePath: sourceFilePath!,
              startMs: clip.startMs,
              endMs: clip.endMs,
              workDir,
            });
            usage.cameraInput += used.inputTokens;
            usage.cameraOutput += used.outputTokens;
            usage.cameraFrames += used.frames;
            cameraLog.push({ title: clip.title, result: result.pass ? "pass" : result.reason, at: result.pass ? undefined : result.at });
            return result;
          } catch (error) {
            // Fails closed: a clip nobody could check is not a first pick.
            cameraLog.push({ title: clip.title, result: "unchecked", error: String(error) });
            return { pass: false as const, reason: "unchecked" as const, at: clip.startMs / 1000 };
          }
        }
      : null;

    const result = await applyLabSelectionSteps(params.ranked, {
      segments: params.segments,
      targetCount: params.targetCount,
      boundary,
      cameraCheck,
      sermonSpan: span,
    });

    await recordOperationalEventSafely(params.prisma, {
      workspaceId: params.workspaceId,
      category: "analysis",
      eventType: "lab_selection_steps",
      severity: "info",
      message: `Lab steps: ${result.outsideSermon} clips outside the sermon, ${result.boundaryChanged} clips moved to sentence boundaries, ${result.rejected.length} rejected by the camera check.`,
      projectId: params.projectId,
      jobId: params.jobId,
      metadata: {
        spanOn,
        boundaryOn,
        cameraOn,
        sermonSpan: spanLog,
        outsideSermon: result.outsideSermon,
        boundaryChanged: result.boundaryChanged,
        rejected: result.rejected,
        boundary: boundaryLog,
        camera: cameraLog,
        usage,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      },
    });
    return result.clips;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
