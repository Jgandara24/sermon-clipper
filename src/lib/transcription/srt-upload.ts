import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Project, SourceVideo } from "@prisma/client";
import { assessSourceReanalysis, REANALYSIS_BLOCKED, REANALYSIS_BLOCKED_MESSAGE } from "@/lib/analysis/reanalysis-policy";
import type { StorageProvider } from "@/lib/storage";
import { discardUnreferencedSrt, SRT_STAGE_LIFETIME_MS } from "./srt-storage";

export class SrtUploadRefusedError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function sourceChanged() {
  return new SrtUploadRefusedError("SRT_SOURCE_CHANGED", "This source changed during the upload. Refresh before trying again.");
}
function processingActive() {
  return new SrtUploadRefusedError("SRT_PROCESSING_ACTIVE", "This source has processing work in progress. Wait for it to finish before uploading subtitles.");
}

async function supersedableJobs(client: PrismaClient | Prisma.TransactionClient, sourceVideoId: string, projectId?: string) {
  const active = await client.processingJob.findMany({ where: {
    project: { sourceVideoId }, state: { in: ["QUEUED", "RETRYING", "WAITING", "RUNNING"] },
  } });
  // Never cancel a sibling, another stage, running work, or a billing reservation.
  if (active.some((job) => job.projectId !== projectId || job.type !== "TRANSCRIBE" ||
      (job.state !== "QUEUED" && job.state !== "RETRYING") || (job.minutesReserved?.toNumber() ?? 0) > 0)) {
    throw processingActive();
  }
  return active;
}

/** Stage bytes once; commit the pointer and replacement queue entry together. */
export async function replaceSrtOverride(client: PrismaClient, storage: StorageProvider, input: {
  source: SourceVideo;
  project: Pick<Project, "id" | "workspaceId"> | null;
  text: string;
  maxBytes: number;
}) {
  const { source, project } = input;
  const uploadId = randomUUID();
  const srtKey = `srt/${source.workspaceId}/${source.id}/${uploadId}.srt`;
  const stagedAt = Date.now();
  // Save a storage write when existing work already refuses the request. Rechecked at commit.
  await supersedableJobs(client, source.id, project?.id);
  try {
    await storage.writeFromWebStream(srtKey, new Blob([input.text]).stream(), input.maxBytes);
    await client.$transaction(async (tx) => {
      // Matches ANALYZE/replacement/retention order. Bytes are already staged; only an existence
      // check occurs under the lock so cleanup cannot remove the input before its pointer commits.
      if (project) {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id}::uuid FOR NO KEY UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${source.id}::uuid FOR UPDATE`;
      const current = await tx.sourceVideo.findUnique({ where: { id: source.id } });
      if (!current || current.updatedAt.getTime() !== source.updatedAt.getTime() ||
          current.srtOverrideKey !== source.srtOverrideKey || current.transcriptRevision !== source.transcriptRevision) {
        throw sourceChanged();
      }
      if (Date.now() - stagedAt >= SRT_STAGE_LIFETIME_MS) {
        throw new SrtUploadRefusedError("SRT_UPLOAD_EXPIRED", "The subtitle upload took too long. Try the upload again.");
      }
      if (!(await storage.exists(srtKey))) {
        throw new SrtUploadRefusedError("SRT_UPLOAD_MISSING", "The uploaded subtitles are no longer available. Upload the file again.");
      }
      if (project) {
        const currentProject = await tx.project.findUnique({ where: { id: project.id } });
        if (!currentProject || currentProject.sourceVideoId !== source.id || currentProject.workspaceId !== source.workspaceId) {
          throw sourceChanged();
        }
      }
      const work = await assessSourceReanalysis(tx, { sourceVideoId: source.id });
      if (!work.allowed) throw new SrtUploadRefusedError(REANALYSIS_BLOCKED, REANALYSIS_BLOCKED_MESSAGE);

      const active = await supersedableJobs(tx, source.id, project?.id);
      if (active.length > 0) {
        // claimNextJob uses the opposite conditional transition on these same rows. If it claims
        // one first, the count changes and this whole upload rolls back. If this wins, claim's
        // QUEUED/RETRYING predicate no longer matches and that worker does not run the old job.
        const canceled = await tx.processingJob.updateMany({ where: {
          id: { in: active.map((job) => job.id) }, state: { in: ["QUEUED", "RETRYING"] },
        }, data: {
          state: "CANCELED", errorCode: "SRT_SUPERSEDED",
          errorMessageUser: "A new subtitle upload replaced this queued transcription.",
          finishedAt: new Date(), workerId: null, heartbeatAt: null,
        } });
        if (canceled.count !== active.length) throw processingActive();
      }
      await tx.sourceVideo.update({ where: { id: source.id }, data: { srtOverrideKey: srtKey } });
      if (project) {
        await tx.processingJob.create({ data: {
          projectId: project.id, type: "TRANSCRIBE", state: "QUEUED",
          idempotencyKey: `transcribe:${project.id}:srt:${uploadId}`,
        } });
      }
    });
  } catch (error) {
    // Also handles an uncertain transaction response. Never delete a key a committed source now
    // references. Failed cleanup is private and is recovered by the age-based worker sweep.
    await discardUnreferencedSrt(client, srtKey, storage);
    throw error;
  }
  // The former input stays through the orphan grace period. This also covers readers already
  // in progress and a process crash immediately after the database commit.
  return { sourceVideoId: source.id, srtKey };
}
