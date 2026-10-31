import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PrismaClient } from "@prisma/client";
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
import { applyLabSelectionSteps, orderByAgreement } from "./lab-selection";
import type { ResolvedSelectionSteps, SelectionStepDegradation } from "./selection-steps";
import { findSermonSpan, SermonSpanSchema, type SermonSpan } from "./sermon-span";
import type { AnalysisUsage } from "./usage";

type LabClip = { startMs: number; endMs: number; text: string; total: number; title: string };
type Segment = { idx: number; startMs: number; endMs: number; text: string };

/**
 * Agreement ranking: asks for the candidates a second time and puts the moments both runs found
 * first (orderByAgreement). Fails open: on any error the first run's order stands, and the step
 * is reported as degraded. Records what it did as one operational event; the second run's tokens
 * go there, not to cost facts, like the other selection steps.
 */
export async function runAgreementRanking<T extends LabClip>(params: {
  prisma: PrismaClient;
  workspaceId: string;
  projectId: string;
  jobId: string;
  /** The selection steps resolved for this job (src/lib/analysis/selection-steps.ts). */
  steps: ResolvedSelectionSteps;
  ranked: T[];
  /** The second candidate run, ranked the same way as the first. */
  scoreAgain: () => Promise<{ startMs: number; endMs: number; title: string; total: number }[]>;
  usage: () => AnalysisUsage | null | undefined;
}): Promise<{ clips: T[]; degraded: SelectionStepDegradation[] }> {
  if (!params.steps.agreementRanking.on) return { clips: params.ranked, degraded: [] };
  const startedAt = Date.now();
  let second: { startMs: number; endMs: number; title: string; total: number }[] | null = null;
  let error: string | null = null;
  try {
    second = await params.scoreAgain();
  } catch (caught) {
    error = String(caught);
  }
  const ordered = second ? orderByAgreement(params.ranked, second) : { clips: params.ranked, agreed: [] as T[] };
  const usage = params.usage();
  await recordOperationalEventSafely(params.prisma, {
    workspaceId: params.workspaceId,
    category: "analysis",
    eventType: "lab_agreement_ranking",
    severity: "info",
    message: second
      ? `Agreement ranking: ${ordered.agreed.length} of ${params.ranked.length} moments found by both candidate runs come first.`
      : "Agreement ranking: the second candidate run failed, so the first run's order stands.",
    projectId: params.projectId,
    jobId: params.jobId,
    metadata: {
      steps: params.steps,
      error,
      agreed: ordered.agreed.length,
      first: params.ranked.map((clip) => ({
        title: clip.title, startMs: clip.startMs, endMs: clip.endMs, total: clip.total, agreed: ordered.agreed.includes(clip),
      })),
      second: second?.map((clip) => ({ title: clip.title, startMs: clip.startMs, endMs: clip.endMs, total: clip.total })) ?? null,
      usage: usage
        ? { inputTokens: usage.totalInputTokens, outputTokens: usage.totalOutputTokens, estimatedCostUsd: usage.estimatedCostUsd }
        : null,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    },
  });
  return {
    clips: ordered.clips,
    degraded: second ? [] : [{ step: "agreementRanking", detail: error ?? "the second candidate run failed" }],
  };
}

/**
 * Runs the sermon span, the boundary step (with fix M's look past the end), the audio dropout
 * check (fix Q) and the camera check, whichever steps are on, on ANALYZE's ranked clips and
 * records what each did as one operational event. Not cost-metered: the token counts go in the
 * event instead. A fail-open step that failed for every clip it tried comes back as degraded, so
 * the job can raise one alert for it.
 */
export async function runLabSelection<T extends LabClip>(params: {
  prisma: PrismaClient;
  workspaceId: string;
  projectId: string;
  jobId: string;
  /** The selection steps resolved for this job (src/lib/analysis/selection-steps.ts). */
  steps: ResolvedSelectionSteps;
  /** The detector Python; present whenever the camera check is on. */
  detectorPython: string | undefined;
  sourceStorageKey: string | null;
  ranked: T[];
  segments: Segment[];
  targetCount: number;
}): Promise<{ clips: T[]; degraded: SelectionStepDegradation[] }> {
  const boundaryOn = params.steps.boundaryStep.on;
  const cameraOn = params.steps.cameraCheck.on && Boolean(params.sourceStorageKey) && Boolean(params.detectorPython);
  const spanOn = params.steps.sermonSpan.on;
  const dropoutOn = params.steps.dropoutCheck.on && Boolean(params.sourceStorageKey);
  if (!boundaryOn && !cameraOn && !spanOn && !dropoutOn) return { clips: params.ranked, degraded: [] };

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
    adjustedStart?: boolean;
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
  const cameraLog: { title: string; result: string; at?: number; via?: string; error?: string }[] = [];
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
              adjustedStart: range?.adjustedStart,
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
              python: params.detectorPython!,
              sourceFilePath: sourceFilePath!,
              startMs: clip.startMs,
              endMs: clip.endMs,
              workDir,
            });
            usage.cameraInput += used.inputTokens;
            usage.cameraOutput += used.outputTokens;
            usage.cameraFrames += used.frames;
            cameraLog.push({
              title: clip.title,
              result: result.pass ? "pass" : result.reason,
              at: result.pass ? undefined : result.at,
              via: result.pass ? undefined : result.via,
            });
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

    // Degraded: a fail-open step that failed for every clip it tried, or a camera check that could
    // check no clip at all. Single failures stay inside the per-clip logs below.
    const degraded: SelectionStepDegradation[] = [];
    if (spanOn && spanLog?.error) degraded.push({ step: "sermonSpan", detail: spanLog.error });
    if (dropoutOn && dropoutLog?.error) degraded.push({ step: "dropoutCheck", detail: dropoutLog.error });
    if (boundaryOn && boundaryLog.length > 0 && boundaryLog.every((entry) => entry.error)) {
      degraded.push({ step: "boundaryStep", detail: boundaryLog[0].error ?? "every boundary call failed" });
    }
    if (cameraOn && cameraLog.length > 0 && cameraLog.every((entry) => entry.result === "unchecked")) {
      degraded.push({ step: "cameraCheck", detail: cameraLog[0].error ?? "no clip could be checked" });
    }

    await recordOperationalEventSafely(params.prisma, {
      workspaceId: params.workspaceId,
      category: "analysis",
      eventType: "lab_selection_steps",
      severity: "info",
      message: `Selection steps: ${result.outsideSermon} clips outside the sermon, ${result.boundaryChanged} clips moved to sentence boundaries, ${result.rejected.length} rejected by the audio and camera checks.`,
      projectId: params.projectId,
      jobId: params.jobId,
      metadata: {
        steps: params.steps,
        degraded: degraded.map((entry) => entry.step),
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
        storiesCut: boundaryLog.filter((b) => b.story && "outcome" in b.story && b.story.outcome === "cut").length,
        endsSnapped: boundaryLog.filter((b) => b.endSnap && "movedMs" in b.endSnap).length,
        rejected: result.rejected,
        boundary: boundaryLog,
        camera: cameraLog,
        usage,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      },
    });
    return { clips: result.clips, degraded };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
