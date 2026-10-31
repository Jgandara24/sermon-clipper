import { assertOriginalRegionExportAllowed, assertRegionExportAllowed } from "@/lib/media-regions/export-policy";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, RenderQcStatus, type ExportJob, type PrismaClient } from "@prisma/client";
import { resolveJobSelectionSteps, selectionStepUnavailableEvent } from "@/lib/analysis/selection-steps";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { detectorPython, env } from "@/lib/env";
import { computeLabSpeakerTrack } from "@/lib/speaker-tracking/lab-observe";
import type { LabTrack } from "@/lib/speaker-tracking/lab-track";
import type { EditorState } from "@/lib/editor/types";
import { flattenWords, wordsInRange } from "@/lib/editor/words";
import { measureWordLevels } from "@/lib/export/word-levels";
import { countCaptionDialogueEvents } from "@/lib/export/ass-generator";
import { renderClipExport } from "@/lib/export/render";
import { probeVideoFile } from "@/lib/media/probe";
import { StorageDownloadError } from "@/lib/storage/types";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import {
  evaluateRenderOutputQc,
  RENDER_QC_FAILED,
  RENDER_QC_FAILED_MESSAGE,
  renderQcDurationToleranceS,
} from "@/lib/qc/render-output";
import {
  getStorageProvider,
  storageProviderKind,
  storageTransferCostFact,
  type StorageDownloadResult,
} from "@/lib/storage";
import { assertContinuousRange } from "./continuous-range";
import { buildExportRenderPlan } from "./render-plan";
import { loadPinnedEditorState } from "./edit-version";
import { ExportFailureError } from "./errors";

import { withMaterializedRange } from "@/lib/media-artifacts/read-lease";
import { renderCandidateRangeExport } from "./range-render";
import { rangeExportsEnabled } from "./range-policy";
import { FULL_SOURCE_FALLBACK_COST_INPUT } from "./full-source-fallback";
import type { ProcessingCostDetails } from "@/lib/cost/types";

// Re-exported so existing importers (worker runner, tests) keep a single failure type.
export { ExportFailureError };

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
/** Schema version of the stored `ExportJob.qcDetails` document. */
const QC_DETAILS_VERSION = 1;
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function recordExportStorageFact(params: {
  prisma: PrismaClient;
  job: ExportJob;
  projectId: string;
  direction: "download" | "upload";
  bytes: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
  download?: StorageDownloadResult | void;
  details?: ProcessingCostDetails;
}) {
  const price =
    params.direction === "download"
      ? env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD
      : env.STORAGE_UPLOAD_PRICE_PER_GB_USD;
  await recordProcessingCostFactSafely(params.prisma, {
    ...storageTransferCostFact({
      direction: params.direction,
      bytes: params.bytes,
      provider: storageProviderKind(),
      configuredPricePerGbUsd: price ?? null,
      wallTimeMs: params.wallTimeMs,
      attempt: Math.max(1, params.job.attempt),
      outcome: params.outcome,
      download: params.download,
    }),
    ...(params.details ? { details: params.details } : {}),
    workspaceId: params.job.workspaceId,
    projectId: params.projectId,
    clipId: params.job.clipId,
    exportJobId: params.job.id,
  });
}

async function recordRenderFact(params: {
  prisma: PrismaClient;
  job: ExportJob;
  projectId: string;
  durationS: number;
  cpuTimeMs: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
  details?: ProcessingCostDetails;
}) {
  await recordProcessingCostFactSafely(params.prisma, {
    stage: "render",
    quantity: params.durationS,
    unit: "second",
    unitCostUsd: 0,
    provider: "ffmpeg",
    model: null,
    providerProvenance: "local_worker_runtime",
    cpuTimeMs: params.cpuTimeMs,
    wallTimeMs: params.wallTimeMs,
    cacheState: "miss",
    attempt: Math.max(1, params.job.attempt),
    outcome: params.outcome,
    ...(params.details ? { details: params.details } : {}),
    workspaceId: params.job.workspaceId,
    projectId: params.projectId,
    clipId: params.job.clipId,
    exportJobId: params.job.id,
  });
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Renders one clip export end to end (guide §15 step 3): loads the exact editor state the job
 * was enqueued against (ExportJob.editVersion) plus the transcript, derives the one source range,
 * the crop and the captions exactly like the editor preview does (same pure helpers), renders via
 * ffmpeg in one pass, then records the resulting file. Returns the new ExportedFile id.
 */
export async function runExportJob(prisma: PrismaClient, job: ExportJob): Promise<string> {
  const clip = await prisma.generatedClip.findUniqueOrThrow({
    where: { id: job.clipId },
    include: {
      project: {
        include: {
          sourceVideo: { include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } } },
          workspace: { select: { settings: true } },
        },
      },
    },
  });

  const rangeInput = await prisma.exportRangeInput.findUnique({ where: { exportJobId: job.id } });
  if (rangeInput && !rangeExportsEnabled()) throw new ExportFailureError("RANGE_EXPORTS_DISABLED", "Range exports are not enabled.", { terminal: true });
  const fallback = rangeInput ? null : await prisma.exportFullSourceFallback.findUnique({ where: { exportJobId: job.id } });
  // While ranges are the normal input, an original read needs an explicit, visible fallback record.
  if (!rangeInput && !fallback && rangeExportsEnabled()) {
    throw new ExportFailureError("FULL_SOURCE_FALLBACK_REQUIRED",
      "This export needs an approved media range or an operator-approved full-source fallback.", { terminal: true });
  }
  const costDetails: ProcessingCostDetails | undefined = fallback ? { exportInput: FULL_SOURCE_FALLBACK_COST_INPUT,
    fullSourceFallbackId: fallback.id, editorialExceptionId: fallback.editorialExceptionId } : undefined;
  const sourceVideo = clip.project.sourceVideo;
  if (!sourceVideo || (!rangeInput && !sourceVideo.storageKey) || sourceVideo.width === null || sourceVideo.height === null) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.");
  }

  // Pinned, not latest: the job renders the version the user asked for, even if newer edits
  // were saved between the request and this run (P1.1).
  const state: EditorState = await loadPinnedEditorState(prisma, {
    clipId: job.clipId,
    editVersion: job.editVersion,
    defaults: { sourceVideoId: sourceVideo.id, startMs: clip.startMs, endMs: clip.endMs },
  });

  if (state.source.videoId !== sourceVideo.id) {
    throw new ExportFailureError("EXPORT_REGION_SOURCE_MISMATCH", "The source evidence does not match this workspace.", { terminal: true });
  }

  const segments = (sourceVideo.transcript?.segments ?? []).map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    words: segment.words as Array<{
      word: string;
      startMs: number;
      endMs: number;
      confidence: number;
      isFiller: boolean;
      deleted: boolean;
    }>,
  }));

  // The delivery gate, checked against the pinned document rather than whatever the clip looks
  // like now. It sits above every piece of work this function does — no source download, no probe,
  // no ffmpeg — so a refused export costs nothing and produces nothing. The route checks too, but
  // this is the check that binds: it catches a job queued before the rule existed, a retry of one,
  // and any other path that reaches the worker.
  assertContinuousRange(state, segments);

  const brandTemplate = state.brandTemplateId
    ? await prisma.brandTemplate.findFirst({
        where: { id: state.brandTemplateId, workspaceId: job.workspaceId },
      })
    : null;

  // The selection steps (docs/SELECTION_STEPS_SETTINGS_PLAN.md), resolved once for this job from
  // the environment gate, this workspace's gate and the detector Python. Both export steps are
  // off until an operator sets both gates.
  const resolution = await resolveJobSelectionSteps({
    environment: env,
    workspaceSettings: clip.project.workspace.settings,
    configuredPython: detectorPython(),
  });
  const selectionSteps = resolution.steps;
  const detector = resolution.detectorPython;

  // Every render decision the document implies, derived in one pure place. The parity gate drives
  // the same function with the same document, so what it checks is what this job renders.
  const planInput = {
    state,
    segments,
    sourceWidth: sourceVideo.width,
    sourceHeight: sourceVideo.height,
    outputWidth: OUTPUT_WIDTH,
    outputHeight: OUTPUT_HEIGHT,
    brandTemplate,
    processingConfig: clip.project.processingConfig,
    source: { id: sourceVideo.id, durationMs: sourceVideo.durationS ? Math.round(sourceVideo.durationS.toNumber() * 1000) : null },
    captionGrouping: selectionSteps.phraseCaptions.on ? ("phrases" as const) : undefined,
  };
  const plan = buildExportRenderPlan(planInput);
  const { range, cropPixels, assContent } = plan;
  // Phrase captions are rebuilt once the source is on disk, without quiet congregation responses.
  let captionPlan = plan;
  if (rangeInput && (rangeInput.sourceVideoId !== sourceVideo.id || rangeInput.editVersion !== job.editVersion ||
    rangeInput.startMs !== BigInt(range.startMs) || rangeInput.endMs !== BigInt(range.endMs))) {
    throw new ExportFailureError("EXPORT_RANGE_PIN_CHANGED", "The saved range input no longer matches this export.", { terminal: true });
  }
  if (fallback && (fallback.sourceVideoId !== sourceVideo.id || fallback.workspaceId !== job.workspaceId ||
    fallback.editVersion !== job.editVersion || fallback.startMs !== BigInt(range.startMs) || fallback.endMs !== BigInt(range.endMs))) {
    throw new ExportFailureError("FULL_SOURCE_FALLBACK_CHANGED", "The approved full-source fallback no longer matches this export.", { terminal: true });
  }

  const regionRequest = rangeInput ? { workspaceId: job.workspaceId, sourceVideoId: sourceVideo.id,
    sourceSha256: rangeInput.sourceSha256, sourceInterval: range } : null;
  const checkRegions = () => regionRequest ? assertRegionExportAllowed(prisma, regionRequest)
    : assertOriginalRegionExportAllowed(prisma, { workspaceId: job.workspaceId, sourceVideoId: sourceVideo.id, sourceInterval: range });
  await checkRegions();

  const storage = getStorageProvider();
  const exportsKey = `exports/${job.workspaceId}/${job.id}.mp4`;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-export-"));
  const sourceFilePath = path.join(workDir, "source-video");
  const outputPath = path.join(workDir, "output.mp4");
  // Measured, never substituted: the old path wrote the OUTPUT_WIDTH/OUTPUT_HEIGHT constants
  // into ExportedFile whenever the probe had failed, so a wrongly shaped file was recorded as a
  // correctly shaped one.
  let outputWidth: number;
  let outputHeight: number;
  let bytes: number;
  let checksum: string;
  let sourceBytes = Number(sourceVideo.sizeBytes ?? BigInt(0));
  const outputDurationS = plan.outputDurationS;

  try {
    if (rangeInput) {
      const downloadStartedAt = Date.now();
      let downloaded = false;
      try {
        await withMaterializedRange(prisma, storage, { workspaceId: job.workspaceId, sourceVideoId: sourceVideo.id,
          artifactId: rangeInput.artifactId, sourceSha256: rangeInput.sourceSha256, ownerId: randomUUID(),
          sourceRange: range, temporaryRoot: workDir, exportJobId: job.id }, async materialized => {
          downloaded = true;
          sourceBytes = Number(materialized.artifact.byteCount);
          await recordExportStorageFact({ prisma, job, projectId: clip.projectId, direction: "download", bytes: sourceBytes,
            download: materialized.download, wallTimeMs: Date.now() - downloadStartedAt, outcome: "succeeded" });
          const started = startRuntimeMeasurement();
          try {
            await renderCandidateRangeExport({ artifact: materialized.artifact, sourceVideoId: sourceVideo.id,
              sourceSha256: rangeInput.sourceSha256, sourceWidth: materialized.sourceWidth, sourceHeight: materialized.sourceHeight, now: new Date(),
              retentionHeldByExportJobId: materialized.retentionHeldByExportJobId,
              render: { sourceFilePath: materialized.path, range, cropPixels, assFileContent: assContent, outputPath,
                outputWidth: OUTPUT_WIDTH, outputHeight: OUTPUT_HEIGHT, originalVolume: plan.originalVolume } });
          } catch (error) {
            await recordRenderFact({ prisma, job, projectId: clip.projectId, durationS: outputDurationS,
              ...finishRuntimeMeasurement(started), outcome: "failed" });
            throw error;
          }
          await recordRenderFact({ prisma, job, projectId: clip.projectId, durationS: outputDurationS,
            ...finishRuntimeMeasurement(started), outcome: "succeeded" });
        });
      } catch (error) {
        if (!downloaded) await recordExportStorageFact({ prisma, job, projectId: clip.projectId, direction: "download",
          bytes: error instanceof StorageDownloadError ? error.download?.transferredBytes ?? 0 : 0,
          download: error instanceof StorageDownloadError ? error.download : undefined,
          wallTimeMs: Date.now() - downloadStartedAt, outcome: "failed" });
        // A failed pinned range never becomes an implicit original-source download.
        throw new ExportFailureError("EXPORT_RANGE_INPUT_FAILED", "The approved range could not render. Review this export before retrying.",
          { terminal: true, cause: error });
      }
    } else {
      const downloadStartedAt = Date.now();
      let download: StorageDownloadResult | void;
      try {
        download = await storage.downloadToFile(sourceVideo.storageKey!, sourceFilePath);
        if (sourceBytes === 0) sourceBytes = (await stat(sourceFilePath)).size;
      } catch (error) {
        await recordExportStorageFact({
          prisma,
          job,
          projectId: clip.projectId,
          direction: "download",
          bytes: sourceBytes,
          download: error instanceof StorageDownloadError ? error.download : undefined,
          wallTimeMs: Date.now() - downloadStartedAt,
          outcome: "failed",
          details: costDetails,
        });
        throw error;
      }
      await recordExportStorageFact({
        prisma,
        job,
        projectId: clip.projectId,
        direction: "download",
        bytes: sourceBytes,
        download,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "succeeded",
        details: costDetails,
      });

      // Speaker tracking: follow the preacher instead of the fixed center crop. A person's manual
      // crop always wins. If tracking fails, the clip still renders with the fixed crop.
      let speakerTrack: LabTrack | undefined;
      const trackingWanted = state.layout.mode !== "manual";
      if (trackingWanted && selectionSteps.speakerTracking.on && detector) {
        try {
          speakerTrack = await computeLabSpeakerTrack({ python: detector, sourceFilePath, range, workDir });
          await recordOperationalEventSafely(prisma, {
            workspaceId: job.workspaceId,
            category: "export",
            eventType: "lab_speaker_tracking",
            severity: "info",
            message: `Speaker tracking follows the preacher ${speakerTrack.followingPercent}% of the clip.`,
            metadata: {
              exportJobId: job.id,
              clipId: clip.id,
              steps: selectionSteps,
              followingPercent: speakerTrack.followingPercent,
              holds: speakerTrack.holds,
              shots: speakerTrack.shots,
              addedCuts: speakerTrack.addedCuts,
              filledFrames: speakerTrack.filledFrames,
              bodyFilledFrames: speakerTrack.bodyFilledFrames,
              offCrop: speakerTrack.offCrop,
            },
          });
        } catch (error) {
          await recordOperationalEventSafely(prisma, {
            workspaceId: job.workspaceId,
            category: "export",
            eventType: "lab_speaker_tracking_failed",
            severity: "warning",
            message: "Speaker tracking failed; the clip renders with the fixed crop.",
            metadata: { exportJobId: job.id, clipId: clip.id, steps: selectionSteps, detail: error instanceof Error ? error.message : String(error) },
          });
        }
      } else if (trackingWanted && resolution.detectorProblem !== null && selectionSteps.speakerTracking.reason === "no-detector") {
        // On in both gates and unable to run, for a render that would have tracked: one error event,
        // not a failed render. A manual crop never asks for the detector, so it never misses it.
        await recordOperationalEventSafely(prisma, {
          workspaceId: job.workspaceId,
          clipId: job.clipId,
          exportJobId: job.id,
          ...selectionStepUnavailableEvent({ step: "speakerTracking", consequence: "the clip renders with the fixed crop", steps: selectionSteps }),
        });
      }

      // Phrase captions, fix G1: leave the congregation's quiet "Amen." out of the captions. If the
      // measurement fails, the clip renders with every word, as before.
      if (planInput.captionGrouping === "phrases") {
        try {
          const words = wordsInRange(flattenWords(segments), range.startMs, range.endMs);
          const captionWordLevels = await measureWordLevels({ sourceFilePath, range, words, workDir });
          captionPlan = buildExportRenderPlan({ ...planInput, captionWordLevels });
          await recordOperationalEventSafely(prisma, {
            workspaceId: job.workspaceId,
            category: "export",
            eventType: "lab_caption_cleanup",
            severity: "info",
            message: `Phrase captions: ${plan.captionLineCount} lines before the congregation check, ${captionPlan.captionLineCount} after.`,
            metadata: { exportJobId: job.id, clipId: clip.id, steps: selectionSteps, measuredWords: captionWordLevels.size, linesBefore: plan.captionLineCount, linesAfter: captionPlan.captionLineCount },
          });
        } catch (error) {
          await recordOperationalEventSafely(prisma, {
            workspaceId: job.workspaceId,
            category: "export",
            eventType: "lab_caption_cleanup_failed",
            severity: "warning",
            message: "The phrase captions' loudness check failed; the clip renders with every word.",
            metadata: { exportJobId: job.id, clipId: clip.id, steps: selectionSteps, detail: error instanceof Error ? error.message : String(error) },
          });
        }
      }

      const renderStartedAt = startRuntimeMeasurement();
      try {
        await renderClipExport({
          sourceFilePath,
          range,
          cropPixels,
          assFileContent: captionPlan.assContent,
          outputPath,
          outputWidth: OUTPUT_WIDTH,
          outputHeight: OUTPUT_HEIGHT,
          originalVolume: plan.originalVolume,
          speakerTrack: speakerTrack && {
            commands: speakerTrack.commands,
            crop: speakerTrack.crop,
            first: speakerTrack.first,
          },
        });
      } catch (error) {
        await recordRenderFact({
          prisma,
          job,
          projectId: clip.projectId,
          durationS: outputDurationS,
          ...finishRuntimeMeasurement(renderStartedAt),
          outcome: "failed",
          details: costDetails,
        });
        throw error;
      }
      await recordRenderFact({
        prisma,
        job,
        projectId: clip.projectId,
        durationS: outputDurationS,
        ...finishRuntimeMeasurement(renderStartedAt),
        outcome: "succeeded",
        details: costDetails,
      });

    }

    const outputBytes = (await stat(outputPath)).size;

    // P1.3: the file proves itself before anything keeps it. Nothing is uploaded until QC passes,
    // so a render that did not decode, lost its audio, came out the wrong shape, ran short, or
    // burned in none of its captions never becomes a stored, deliverable file.
    let probeError: string | null = null;
    const probed = await probeVideoFile(outputPath).catch((error: unknown) => {
      probeError = error instanceof Error ? error.message : String(error);
      return null;
    });
    const outputChecksum = await hashFile(outputPath);
    const qc = evaluateRenderOutputQc(
      {
        probe: probed,
        probeError,
        bytes: outputBytes,
        checksum: outputChecksum,
        captionEvents: countCaptionDialogueEvents(captionPlan.assContent),
      },
      {
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        durationS: outputDurationS,
        durationToleranceS: renderQcDurationToleranceS(outputDurationS),
        captionLines: captionPlan.captionLineCount,
        completeMessageTiming: plan.completeMessageTiming,
      },
    );

    const regionCheck = await checkRegions();

    // The verdict is recorded either way, so a refused render leaves evidence rather than only a
    // failure code. The checksum stored here is the same value ExportedFile receives, so the two
    // can be asserted equal instead of assumed to agree.
    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        qcStatus: qc.status === "PASSED" ? RenderQcStatus.PASSED : RenderQcStatus.FAILED,
        qcCheckedAt: new Date(),
        qcChecksum: outputChecksum,
        qcDetails: { version: QC_DETAILS_VERSION, checks: qc.checks, regionCheck,
          mediaInput: rangeInput ? { kind: "CANDIDATE_RANGE", artifactId: rangeInput.artifactId,
            reviewId: rangeInput.reviewId, sha256: rangeInput.artifactSha256, editVersion: rangeInput.editVersion }
            : { kind: "ORIGINAL", sourceVideoId: sourceVideo.id, sourceInterval: range, editVersion: job.editVersion,
              ...(fallback ? { fullSourceFallbackId: fallback.id, editorialExceptionId: fallback.editorialExceptionId } : {}) } } as Prisma.InputJsonValue,
      },
    });

    if (qc.status === "FAILED") {
      await recordOperationalEventSafely(prisma, {
        workspaceId: job.workspaceId,
        category: "export",
        eventType: "export_render_qc_failed",
        severity: "warning",
        message: "A rendered export failed quality control and was not saved.",
        clipId: job.clipId,
        exportJobId: job.id,
        metadata: {
          editVersion: job.editVersion,
          attempt: job.attempt,
          failures: qc.failures.map((check) => ({ name: check.name, detail: check.detail })),
        },
      });
      throw new ExportFailureError(RENDER_QC_FAILED, RENDER_QC_FAILED_MESSAGE);
    }

    if (!probed || probed.width === null || probed.height === null) {
      // Unreachable: the decode and dimension checks refuse this file first. Kept so the recorded
      // dimensions can only ever be the measured ones.
      throw new ExportFailureError(RENDER_QC_FAILED, RENDER_QC_FAILED_MESSAGE);
    }
    outputWidth = probed.width;
    outputHeight = probed.height;

    const uploadStartedAt = Date.now();
    try {
      await storage.uploadFile(exportsKey, outputPath, "video/mp4");
    } catch (error) {
      await recordExportStorageFact({
        prisma,
        job,
        projectId: clip.projectId,
        direction: "upload",
        bytes: outputBytes,
        wallTimeMs: Date.now() - uploadStartedAt,
        outcome: "failed",
        details: costDetails,
      });
      throw error;
    }
    await recordExportStorageFact({
      prisma,
      job,
      projectId: clip.projectId,
      direction: "upload",
      bytes: outputBytes,
      wallTimeMs: Date.now() - uploadStartedAt,
      outcome: "succeeded",
      details: costDetails,
    });
    bytes = await storage.size(exportsKey);
    checksum = outputChecksum;
  } catch (error) {
    // A QC refusal already carries its own code and its own user message. Rewrapping it as
    // RENDER_FAILED would hide which check refused the file.
    if (error instanceof ExportFailureError) {
      throw error;
    }
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.", {
      cause: error,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const exportedFile = await prisma.exportedFile.create({
    data: {
      storageKey: exportsKey,
      bytes: BigInt(bytes),
      width: outputWidth,
      height: outputHeight,
      checksum,
      downloadExpiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS),
    },
  });

  return exportedFile.id;
}
