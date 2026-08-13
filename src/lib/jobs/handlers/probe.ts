import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessingJobType } from "@prisma/client";
import { recordProcessingCostFact } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import type { ProcessingCostOutcome, ProcessingCostStage } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { extractAudio, extractThumbnail } from "@/lib/media/probe";
import {
  getStorageProvider,
  storageProviderKind,
  storageTransferCostFact,
} from "@/lib/storage";

async function recordProbeStorageFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  direction: "download" | "upload";
  bytes: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  const price =
    params.direction === "download"
      ? env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD
      : env.STORAGE_UPLOAD_PRICE_PER_GB_USD;
  await recordProcessingCostFact(params.prisma, {
    ...storageTransferCostFact({
      direction: params.direction,
      bytes: params.bytes,
      provider: storageProviderKind(),
      configuredPricePerGbUsd: price ?? null,
      wallTimeMs: params.wallTimeMs,
      attempt: Math.max(1, params.attempt),
      outcome: params.outcome,
    }),
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

async function recordProbeComputeFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  stage: Extract<ProcessingCostStage, "local_audio_extraction" | "render">;
  quantity: number;
  unit: "second" | "image";
  cpuTimeMs: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  await recordProcessingCostFact(params.prisma, {
    stage: params.stage,
    quantity: params.quantity,
    unit: params.unit,
    unitCostUsd: 0,
    provider: params.stage === "render" ? "ffmpeg_thumbnail" : "ffmpeg_audio",
    model: null,
    providerProvenance: "local_worker_runtime",
    cpuTimeMs: params.cpuTimeMs,
    wallTimeMs: params.wallTimeMs,
    cacheState: "miss",
    attempt: Math.max(1, params.attempt),
    outcome: params.outcome,
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

/** Extracts a poster thumbnail and a 16kHz mono audio track for later transcription. */
export const runProbeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: true },
  });

  const sourceVideo = project.sourceVideo;
  if (!sourceVideo?.storageKey || sourceVideo.durationS === null) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
  }

  const storage = getStorageProvider();
  const thumbnailKey = `thumbs/${project.workspaceId}/${sourceVideo.id}.jpg`;
  const audioKey = `audio/${project.workspaceId}/${sourceVideo.id}.wav`;
  const thumbnailAtS = Math.min(2, sourceVideo.durationS.toNumber() / 2);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-probe-"));
  const sourcePath = path.join(workDir, "source-video");
  const thumbnailPath = path.join(workDir, "thumbnail.jpg");
  const audioPath = path.join(workDir, "audio.wav");
  const attribution = {
    prisma,
    workspaceId: project.workspaceId,
    projectId: project.id,
    jobId: job.id,
    attempt: job.attempt,
  };

  try {
    let sourceBytes = Number(sourceVideo.sizeBytes ?? BigInt(0));
    const downloadStartedAt = Date.now();
    try {
      await storage.downloadToFile(sourceVideo.storageKey, sourcePath);
      if (sourceBytes === 0) sourceBytes = (await stat(sourcePath)).size;
    } catch (error) {
      await recordProbeStorageFact({
        ...attribution,
        direction: "download",
        bytes: sourceBytes,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    await recordProbeStorageFact({
      ...attribution,
      direction: "download",
      bytes: sourceBytes,
      wallTimeMs: Date.now() - downloadStartedAt,
      outcome: "succeeded",
    });

    const thumbnailRuntime = startRuntimeMeasurement();
    try {
      await extractThumbnail(sourcePath, thumbnailPath, thumbnailAtS);
    } catch (error) {
      await recordProbeComputeFact({
        ...attribution,
        stage: "render",
        quantity: 1,
        unit: "image",
        ...finishRuntimeMeasurement(thumbnailRuntime),
        outcome: "failed",
      });
      throw error;
    }
    await recordProbeComputeFact({
      ...attribution,
      stage: "render",
      quantity: 1,
      unit: "image",
      ...finishRuntimeMeasurement(thumbnailRuntime),
      outcome: "succeeded",
    });

    const audioRuntime = startRuntimeMeasurement();
    try {
      await extractAudio(sourcePath, audioPath);
    } catch (error) {
      await recordProbeComputeFact({
        ...attribution,
        stage: "local_audio_extraction",
        quantity: sourceVideo.durationS.toNumber(),
        unit: "second",
        ...finishRuntimeMeasurement(audioRuntime),
        outcome: "failed",
      });
      throw error;
    }
    await recordProbeComputeFact({
      ...attribution,
      stage: "local_audio_extraction",
      quantity: sourceVideo.durationS.toNumber(),
      unit: "second",
      ...finishRuntimeMeasurement(audioRuntime),
      outcome: "succeeded",
    });

    for (const [key, filePath, contentType] of [
      [thumbnailKey, thumbnailPath, "image/jpeg"],
      [audioKey, audioPath, "audio/wav"],
    ] as const) {
      const bytes = (await stat(filePath)).size;
      const uploadStartedAt = Date.now();
      try {
        await storage.uploadFile(key, filePath, contentType);
      } catch (error) {
        await recordProbeStorageFact({
          ...attribution,
          direction: "upload",
          bytes,
          wallTimeMs: Date.now() - uploadStartedAt,
          outcome: "failed",
        });
        throw error;
      }
      await recordProbeStorageFact({
        ...attribution,
        direction: "upload",
        bytes,
        wallTimeMs: Date.now() - uploadStartedAt,
        outcome: "succeeded",
      });
    }
  } catch (error) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "We couldn't process that video file.", {
      cause: error,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  await prisma.sourceVideo.update({
    where: { id: sourceVideo.id },
    data: { thumbnailKey, audioKey },
  });

  await enqueueJob(prisma, {
    projectId: project.id,
    type: ProcessingJobType.TRANSCRIBE,
    idempotencyKey: `transcribe:${project.id}`,
  });
};
