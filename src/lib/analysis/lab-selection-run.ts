import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PrismaClient } from "@prisma/client";
import { labStepEnabled } from "@/lib/lab-flags";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { getStorageProvider } from "@/lib/storage";
import { findAudioDropouts, type AudioDropout } from "./audio-dropout";
import {
  boundaryContext,
  BoundaryChoiceSchema,
  checkStory,
  chooseBoundary,
  EndLookSchema,
  lookPastTheEnd,
  StoryCheckSchema,
  type BoundaryTurn,
  type EndLook,
  type StoryCheck,
} from "./boundary-step";
import { checkClipCamera } from "./camera-check-run";
import { snapClipEnd } from "./end-silence";
import { scoringModel } from "./claude-provider";
import { applyLabSelectionSteps } from "./lab-selection";
import { findSermonSpan, SermonSpanSchema, type SermonSpan } from "./sermon-span";

type LabClip = { startMs: number; endMs: number; text: string; total: number; title: string };
type Segment = { idx: number; startMs: number; endMs: number; text: string };

/**
 * Lab only. Runs the sermon span, the boundary step (with fix M's look past the end), the audio dropout
 * check (fix Q) and the camera check (whichever flags are on) on ANALYZE's
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
  const dropoutOn = labStepEnabled("dropoutCheck") && Boolean(params.sourceStorageKey);
  if (!boundaryOn && !cameraOn && !spanOn && !dropoutOn) return params.ranked;

  const startedAt = Date.now();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "lab-selection-"));
  const usage = {
    spanInput: 0, spanOutput: 0, boundaryInput: 0, boundaryOutput: 0, endLookInput: 0, endLookOutput: 0,
    storyInput: 0, storyOutput: 0,
    cameraInput: 0, cameraOutput: 0, cameraFrames: 0,
  };
  const boundaryLog: {
    title: string;
    from: [number, number];
    to: [number, number] | null;
    adjustedForScripture?: boolean;
    adjustedEnd?: boolean;
    reason?: string;
    attempts?: { startUnit: number; endUnit: number; refused: string | null; question?: string }[];
    endLook?: EndLook | { error: string };
    /** Fix U: the story check, and the boundary step's attempts when the clip restarted later. */
    story?: StoryCheck | { error: string };
    storyAttempts?: { startUnit: number; endUnit: number; refused: string | null; question?: string }[];
    /** Fix V: the cut moved back into the pause before the sound it cut into. */
    endSnap?: { endMs: number; movedMs: number } | { error: string };
    error?: string;
  }[] = [];
  const cameraLog: { title: string; result: string; at?: number; error?: string }[] = [];
  let dropoutLog: { found?: AudioDropout[]; seconds?: number; error?: string } | null = null;
  let spanLog: { firstLine?: number; lastLine?: number; reason?: string; lines?: number; span?: SermonSpan | null; error?: string } | null = null;

  try {
    let sourceFilePath: string | null = null;
    if (cameraOn || dropoutOn) {
      sourceFilePath = path.join(workDir, "source-video");
      await getStorageProvider().downloadToFile(params.sourceStorageKey!, sourceFilePath);
    }

    let audioDropouts: AudioDropout[] | null = null;
    if (dropoutOn) {
      const scanStartedAt = Date.now();
      try {
        // The render plays the source video's sound, so the check reads that file.
        audioDropouts = await findAudioDropouts(sourceFilePath!);
        dropoutLog = { found: audioDropouts, seconds: Math.round((Date.now() - scanStartedAt) / 1000) };
      } catch (error) {
        // Fails open: without a scan the lab keeps every clip, as before fix Q.
        dropoutLog = { error: String(error) };
      }
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
            const askBoundary = async (turns: BoundaryTurn[]) => {
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
            };
            const { range, attempts } = await chooseBoundary(context, askBoundary);
            let final = range && { startMs: range.startMs, endMs: range.endMs };
            let endLook: EndLook | { error: string } | undefined;
            if (final) {
              try {
                const looked = await lookPastTheEnd(context.units, final, async (prompt) => {
                  const message = await new Anthropic().messages.create({
                    model: scoringModel(),
                    max_tokens: 600,
                    thinking: { type: "disabled" },
                    messages: [{ role: "user", content: prompt }],
                    output_config: { format: zodOutputFormat(EndLookSchema) },
                  });
                  usage.endLookInput += message.usage.input_tokens;
                  usage.endLookOutput += message.usage.output_tokens;
                  const block = message.content.find((b) => b.type === "text");
                  return EndLookSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
                });
                final = looked.range;
                endLook = looked.look;
              } catch (error) {
                // Fails open: the end the boundary step accepted stands.
                endLook = { error: String(error) };
              }
            }
            // Fix U: a clip cut from the middle of a story moves to where the story lands, or starts later.
            let story: StoryCheck | { error: string } | undefined;
            let storyAttempts: (typeof boundaryLog)[number]["storyAttempts"];
            if (final) {
              try {
                const checked = await checkStory(context, final, async (prompt) => {
                  const message = await new Anthropic().messages.create({
                    model: scoringModel(),
                    max_tokens: 600,
                    thinking: { type: "disabled" },
                    messages: [{ role: "user", content: prompt }],
                    output_config: { format: zodOutputFormat(StoryCheckSchema) },
                  });
                  usage.storyInput += message.usage.input_tokens;
                  usage.storyOutput += message.usage.output_tokens;
                  const block = message.content.find((b) => b.type === "text");
                  return StoryCheckSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
                }, askBoundary);
                final = checked.range;
                story = checked.check;
                storyAttempts = checked.attempts?.map(({ startUnit, endUnit, refused, question }) => ({ startUnit, endUnit, refused, question }));
              } catch (error) {
                // Fails open: the range stands.
                story = { error: String(error) };
              }
            }
            // Fix V: a cut on a sound that starts right after a pause moves back into the pause. Needs the
            // source file, which the camera check or the dropout check downloads.
            let endSnap: { endMs: number; movedMs: number } | { error: string } | undefined;
            if (final && sourceFilePath) {
              try {
                const snapped = await snapClipEnd(sourceFilePath, final);
                if (snapped) {
                  final = { startMs: final.startMs, endMs: snapped.endMs };
                  endSnap = snapped;
                }
              } catch (error) {
                // Fails open: the cut stays on the transcript's clock.
                endSnap = { error: String(error) };
              }
            }
            boundaryLog.push({
              title: clip.title,
              from: [clip.startMs, clip.endMs],
              to: final ? [final.startMs, final.endMs] : null,
              adjustedForScripture: range?.adjustedForScripture,
              adjustedEnd: range?.adjustedEnd,
              reason: attempts.at(-1)?.reason,
              attempts: attempts.map(({ startUnit, endUnit, refused, question }) => ({ startUnit, endUnit, refused, question })),
              endLook,
              story,
              storyAttempts,
              endSnap,
            });
            return final;
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
      audioDropouts,
    });

    await recordOperationalEventSafely(params.prisma, {
      workspaceId: params.workspaceId,
      category: "analysis",
      eventType: "lab_selection_steps",
      severity: "info",
      message: `Lab steps: ${result.outsideSermon} clips outside the sermon, ${result.boundaryChanged} clips moved to sentence boundaries, ${result.rejected.length} rejected by the audio and camera checks.`,
      projectId: params.projectId,
      jobId: params.jobId,
      metadata: {
        spanOn,
        boundaryOn,
        cameraOn,
        dropoutOn,
        sermonSpan: spanLog,
        audioDropouts: dropoutLog,
        outsideSermon: result.outsideSermon,
        boundaryChanged: result.boundaryChanged,
        endsMovedLater: boundaryLog.filter((b) => b.endLook && "movedMs" in b.endLook && b.endLook.movedMs > 0).length,
        setUpsDropped: boundaryLog.filter((b) => b.endLook && "dropped" in b.endLook && b.endLook.dropped).length,
        storiesExtended: boundaryLog.filter((b) => b.story && "outcome" in b.story && b.story.outcome === "extended").length,
        storiesRestarted: boundaryLog.filter((b) => b.story && "outcome" in b.story && b.story.outcome === "restarted").length,
        storiesUnresolved: boundaryLog.filter((b) => b.story && "outcome" in b.story && b.story.outcome === "unresolved").length,
        endsSnapped: boundaryLog.filter((b) => b.endSnap && "movedMs" in b.endSnap).length,
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
