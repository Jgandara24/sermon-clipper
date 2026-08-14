import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessingJobType } from "@prisma/client";
import { recordProcessingCostFact } from "@/lib/cost/record";
import {
  finishRuntimeMeasurement,
  startRuntimeMeasurement,
  type RuntimeMeasurement,
} from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import {
  getStorageProvider,
  storageProviderKind,
  storageTransferCostFact,
} from "@/lib/storage";
import { applyFillerDetection } from "@/lib/transcription/filler-detection";
import { getTranscriptionProvider } from "@/lib/transcription";
import { parseSrt, SrtParseError } from "@/lib/transcription/srt";
import {
  TranscriptionProviderUnavailableError,
  type TranscriptionResult,
} from "@/lib/transcription/types";

async function recordTranscriptionFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  provider: string;
  durationS: number;
  runtime: RuntimeMeasurement;
  outcome: ProcessingCostOutcome;
  source: "audio" | "srt_override";
}) {
  await recordProcessingCostFact(params.prisma, {
    stage: "transcription",
    quantity: params.durationS / 60,
    unit: "minute",
    unitCostUsd: 0,
    provider: params.provider,
    model: params.provider,
    providerProvenance: "runtime_provider_selection",
    cpuTimeMs: params.runtime.cpuTimeMs,
    wallTimeMs: params.runtime.wallTimeMs,
    cacheState: "miss",
    attempt: Math.max(1, params.attempt),
    outcome: params.outcome,
    details: { source: params.source },
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

async function recordStorageDownloadFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  bytes: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  await recordProcessingCostFact(params.prisma, {
    ...storageTransferCostFact({
      direction: "download",
      bytes: params.bytes,
      provider: storageProviderKind(),
      configuredPricePerGbUsd: env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD ?? null,
      wallTimeMs: params.wallTimeMs,
      attempt: Math.max(1, params.attempt),
      outcome: params.outcome,
    }),
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

/**
 * Transcribes the extracted audio (or parses a user-supplied SRT override, skipping ASR
 * entirely per guide §9 step 5), then persists the transcript + segments. Idempotent: re-running
 * replaces any existing transcript for this source video rather than duplicating it.
 */
export const runTranscribeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: true },
  });

  const sourceVideo = project.sourceVideo;
  if (!sourceVideo) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
  }

  const storage = getStorageProvider();
  let result: TranscriptionResult;
  let providerName: string;

  if (sourceVideo.srtOverrideKey) {
    const downloadStartedAt = Date.now();
    let srtBuffer: Buffer;
    try {
      srtBuffer = await storage.readAsBuffer(sourceVideo.srtOverrideKey);
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: srtBuffer.byteLength,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "succeeded",
      });
    } catch (error) {
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: 0,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    const srtText = srtBuffer.toString("utf-8");
    const transcriptionStartedAt = startRuntimeMeasurement();
    try {
      result = parseSrt(srtText, sourceVideo.language ?? "en");
    } catch (error) {
      await recordTranscriptionFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        provider: "srt_upload",
        durationS: sourceVideo.durationS?.toNumber() ?? 0,
        runtime: finishRuntimeMeasurement(transcriptionStartedAt),
        outcome: "failed",
        source: "srt_override",
      });
      if (error instanceof SrtParseError) {
        throw new JobFailureError("INVALID_FILE_TYPE", "That SRT file couldn't be read.", {
          cause: error,
        });
      }
      throw error;
    }
    providerName = "srt_upload";
    await recordTranscriptionFact({
      prisma,
      workspaceId: project.workspaceId,
      projectId: project.id,
      jobId: job.id,
      attempt: job.attempt,
      provider: providerName,
      durationS:
        sourceVideo.durationS?.toNumber() ??
        Math.max(0, ...result.segments.map((segment) => segment.endMs / 1_000)),
      runtime: finishRuntimeMeasurement(transcriptionStartedAt),
      outcome: "succeeded",
      source: "srt_override",
    });
  } else {
    if (!sourceVideo.audioKey) {
      throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
    }
    const provider = await getTranscriptionProvider();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-transcribe-"));
    const audioPath = path.join(workDir, "audio.wav");
    const audioBytes = await storage.size(sourceVideo.audioKey).catch(() => 0);
    const downloadStartedAt = Date.now();
    let downloadSucceeded = false;
    try {
      await storage.downloadToFile(sourceVideo.audioKey, audioPath);
      downloadSucceeded = true;
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: audioBytes,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "succeeded",
      });
      const transcriptionStartedAt = startRuntimeMeasurement();
      try {
        result = await provider.transcribe({
          audioPath,
          language: sourceVideo.language ?? undefined,
        });
      } catch (error) {
        await recordTranscriptionFact({
          prisma,
          workspaceId: project.workspaceId,
          projectId: project.id,
          jobId: job.id,
          attempt: job.attempt,
          provider: provider.name,
          durationS: sourceVideo.durationS?.toNumber() ?? 0,
          runtime: provider.lastTelemetry ?? finishRuntimeMeasurement(transcriptionStartedAt),
          outcome: "failed",
          source: "audio",
        });
        throw error;
      }
      await recordTranscriptionFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        provider: provider.name,
        durationS:
          sourceVideo.durationS?.toNumber() ??
          Math.max(0, ...result.segments.map((segment) => segment.endMs / 1_000)),
        runtime: provider.lastTelemetry ?? finishRuntimeMeasurement(transcriptionStartedAt),
        outcome: "succeeded",
        source: "audio",
      });
    } catch (error) {
      if (!downloadSucceeded) {
        await recordStorageDownloadFact({
          prisma,
          workspaceId: project.workspaceId,
          projectId: project.id,
          jobId: job.id,
          attempt: job.attempt,
          bytes: audioBytes,
          wallTimeMs: Date.now() - downloadStartedAt,
          outcome: "failed",
        });
      }
      if (error instanceof TranscriptionProviderUnavailableError) {
        throw new JobFailureError(
          "TRANSCRIBE_PROVIDER_UNAVAILABLE",
          "Transcription isn't configured on this environment yet.",
          { cause: error },
        );
      }
      throw new JobFailureError("TRANSCRIBE_FAILED", "We couldn't transcribe the audio.", {
        cause: error,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    providerName = provider.name;
  }

  const segments = applyFillerDetection(result.segments);
  const fullText = segments.map((segment) => segment.text).join(" ");

  await prisma.$transaction(async (tx) => {
    await tx.transcript.deleteMany({ where: { sourceVideoId: sourceVideo.id } });
    const transcript = await tx.transcript.create({
      data: {
        sourceVideoId: sourceVideo.id,
        language: result.language,
        provider: providerName,
        fullText,
      },
    });

    for (const [idx, segment] of segments.entries()) {
      await tx.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          idx,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          words: segment.words,
        },
      });
    }
  });

  // Keyed by this TRANSCRIBE job's own id (not just the project) so a re-run — e.g. after an
  // SRT override upload — always enqueues a fresh ANALYZE pass instead of reusing an already-
  // succeeded one.
  await enqueueJob(prisma, {
    projectId: project.id,
    type: ProcessingJobType.ANALYZE,
    idempotencyKey: `analyze:${project.id}:${job.id}`,
  });

  return {
    metadata: {
      provider: providerName,
      language: result.language,
      segmentCount: segments.length,
      wordCount: segments.reduce((total, segment) => total + segment.words.length, 0),
      source: sourceVideo.srtOverrideKey ? "srt_override" : "audio",
    },
  };
};
