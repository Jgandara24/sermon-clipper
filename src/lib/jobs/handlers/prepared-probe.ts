import os from "node:os";
import path from "node:path";
import { env } from "@/lib/env";
import { getStorageProvider, storageProviderKind } from "@/lib/storage";
import { resolveTranscriptionProviders } from "@/lib/transcription";
import { readSermonPreparationConfig } from "@/lib/media/preparation-config";
import { prepareSermonSource } from "@/lib/media/sermon-preparation";
import { prepareSrtSource } from "@/lib/media/srt-preparation";
import { JobFailureError, type JobHandler } from "../types";

/** Controlled derivative-first PROBE. Any failure stops here without legacy transcription fallback. */
export const runPreparedProbeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: job.projectId }, include: { sourceVideo: true } });
  try {
    const source = project.sourceVideo;
    if (!source?.storageKey) throw new Error("PREPARATION_SOURCE_REQUIRED");
    const config = readSermonPreparationConfig(project.processingConfig);
    const now = Date.now();
    if (config.retention.analysisExpiresAt.getTime() <= now || config.retention.previewExpiresAt.getTime() <= now) {
      throw new Error("PREPARATION_RETENTION_EXPIRED");
    }
    const storageAccounting = { provider: storageProviderKind(), attempt: Math.max(1, job.attempt),
      downloadPricePerGbUsd: env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD ?? null,
      uploadPricePerGbUsd: env.STORAGE_UPLOAD_PRICE_PER_GB_USD ?? null };
    const request = { workspaceId: project.workspaceId, sourceVideoId: source.id, ownerId: job.id,
      temporaryRoot: path.join(os.tmpdir(), "sermon-preparation") };
    // An uploaded SRT is the transcript. Build shared derivatives, then hand off; never replace it with paid ASR.
    if (source.srtOverrideKey) {
      const result = await prepareSrtSource(prisma, getStorageProvider(), { request, projectId: project.id,
        derivatives: config.derivatives, retention: config.retention, localEvidence: config.localEvidence, storageAccounting });
      return { metadata: { preparationVersion: config.version, transcriptSource: "srt_override",
        sourceSessionId: result.batch.sessionId, transcribeJobId: result.transcribeJobId } };
    }
    const { primary } = resolveTranscriptionProviders();
    const result = await prepareSermonSource(prisma, getStorageProvider(), {
      ...config, projectId: project.id, request, provider: primary, language: source.language ?? undefined, storageAccounting,
    });
    return { metadata: { preparationVersion: config.version, sourceSessionId: result.batch.sessionId,
      sermonArtifactId: result.batch.sermon!.artifact.id, submissionId: result.batch.consumption!.submissionId } };
  } catch (cause) {
    if (cause instanceof JobFailureError && cause.preservesProject) throw cause;
    // Serialize exception creation so duplicate attempts retain one open exception per project.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id}::uuid FOR UPDATE`;
      const existing = await tx.editorialException.findFirst({ where: { projectId: project.id,
        exceptionType: "SERMON_PREPARATION_REQUIRED", state: "OPEN" } });
      if (!existing) await tx.editorialException.create({ data: {
        workspaceId: project.workspaceId, projectId: project.id, exceptionType: "SERMON_PREPARATION_REQUIRED",
        message: "Sermon preparation stopped. Review its settings and source evidence before another attempt.",
        projectSnapshot: { id: project.id, name: project.name, sourceVideoId: project.sourceVideoId },
        metadata: { jobId: job.id, attempt: job.attempt, automaticRetry: false, fullSourceFallback: false },
      } });
    });
    throw new JobFailureError("SERMON_PREPARATION_REQUIRED",
      "Sermon preparation stopped. Review the preparation exception before another attempt.", { cause, retryable: false });
  }
};
