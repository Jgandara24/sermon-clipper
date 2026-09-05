import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, RenderQcStatus, type ExportJob, type PrismaClient } from "@prisma/client";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import type { EditorState } from "@/lib/editor/types";
import { countCaptionDialogueEvents } from "@/lib/export/ass-generator";
import { renderClipExport } from "@/lib/export/render";
import { probeVideoFile } from "@/lib/media/probe";
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
} from "@/lib/storage";
import { assertContinuousRange } from "./continuous-range";
import { buildExportRenderPlan } from "./render-plan";
import { loadPinnedEditorState } from "./edit-version";
import { ExportFailureError } from "./errors";

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
    }),
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
        },
      },
    },
  });

  const sourceVideo = clip.project.sourceVideo;
  if (!sourceVideo?.storageKey || sourceVideo.width === null || sourceVideo.height === null) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.");
  }

  // Pinned, not latest: the job renders the version the user asked for, even if newer edits
  // were saved between the request and this run (P1.1).
  const state: EditorState = await loadPinnedEditorState(prisma, {
    clipId: job.clipId,
    editVersion: job.editVersion,
    defaults: { sourceVideoId: sourceVideo.id, startMs: clip.startMs, endMs: clip.endMs },
  });

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

  // Every render decision the document implies, derived in one pure place. The parity gate drives
  // the same function with the same document, so what it checks is what this job renders.
  const plan = buildExportRenderPlan({
    state,
    segments,
    sourceWidth: sourceVideo.width,
    sourceHeight: sourceVideo.height,
    outputWidth: OUTPUT_WIDTH,
    outputHeight: OUTPUT_HEIGHT,
    brandTemplate,
  });
  const { range, cropPixels, assContent } = plan;

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
    const downloadStartedAt = Date.now();
    try {
      await storage.downloadToFile(sourceVideo.storageKey, sourceFilePath);
      if (sourceBytes === 0) sourceBytes = (await stat(sourceFilePath)).size;
    } catch (error) {
      await recordExportStorageFact({
        prisma,
        job,
        projectId: clip.projectId,
        direction: "download",
        bytes: sourceBytes,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    await recordExportStorageFact({
      prisma,
      job,
      projectId: clip.projectId,
      direction: "download",
      bytes: sourceBytes,
      wallTimeMs: Date.now() - downloadStartedAt,
      outcome: "succeeded",
    });

    const renderStartedAt = startRuntimeMeasurement();
    try {
      await renderClipExport({
        sourceFilePath,
        range,
        cropPixels,
        assFileContent: assContent,
        outputPath,
        outputWidth: OUTPUT_WIDTH,
        outputHeight: OUTPUT_HEIGHT,
        originalVolume: plan.originalVolume,
      });
    } catch (error) {
      await recordRenderFact({
        prisma,
        job,
        projectId: clip.projectId,
        durationS: outputDurationS,
        ...finishRuntimeMeasurement(renderStartedAt),
        outcome: "failed",
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
    });

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
        captionEvents: countCaptionDialogueEvents(assContent),
      },
      {
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        durationS: outputDurationS,
        durationToleranceS: renderQcDurationToleranceS(outputDurationS),
        captionLines: plan.captionLineCount,
      },
    );

    // The verdict is recorded either way, so a refused render leaves evidence rather than only a
    // failure code. The checksum stored here is the same value ExportedFile receives, so the two
    // can be asserted equal instead of assumed to agree.
    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        qcStatus: qc.status === "PASSED" ? RenderQcStatus.PASSED : RenderQcStatus.FAILED,
        qcCheckedAt: new Date(),
        qcChecksum: outputChecksum,
        qcDetails: { version: QC_DETAILS_VERSION, checks: qc.checks } as Prisma.InputJsonValue,
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
