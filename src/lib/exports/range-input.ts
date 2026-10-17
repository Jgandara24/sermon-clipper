import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { buildExportIdempotencyKey, loadPinnedEditorState } from "./edit-version";

const requestSchema = z.object({ workspaceId: z.string().uuid(), exportJobId: z.string().uuid(), artifactId: z.string().uuid() }).strict();
export type ExportRangePinRequest = z.infer<typeof requestSchema>;

/** Internal transaction helper. Queue integration must create the job and pin in the same transaction. */
export async function pinExportRangeInput(tx: Prisma.TransactionClient, input: ExportRangePinRequest) {
  const request = requestSchema.parse(input);
  const initial = await tx.exportJob.findUnique({ where: { id: request.exportJobId }, include: { clip: { include: { project: true } } } });
  if (!initial || initial.workspaceId !== request.workspaceId || initial.clip.workspaceId !== request.workspaceId ||
    initial.clip.project.workspaceId !== request.workspaceId || !initial.clip.project.sourceVideoId) throw new Error("EXPORT_RANGE_JOB_NOT_FOUND");
  const sourceVideoId = initial.clip.project.sourceVideoId;
  await lockMediaSource(tx, request.workspaceId, sourceVideoId);
  if (await tx.sourceMediaSession.findFirst({ where: { sourceId: sourceVideoId, state: { not: "COMPLETE" } } })) {
    throw new Error("MEDIA_SOURCE_SESSION_UNFINISHED");
  }
  await tx.$queryRaw`SELECT id FROM export_jobs WHERE id=${request.exportJobId}::uuid FOR UPDATE`;
  const job = await tx.exportJob.findUniqueOrThrow({ where: { id: request.exportJobId } });
  if (job.clipId !== initial.clipId || job.editVersion !== initial.editVersion || job.workspaceId !== request.workspaceId) {
    throw new Error("EXPORT_RANGE_JOB_CHANGED");
  }
  const clip = await tx.generatedClip.findUniqueOrThrow({ where: { id: job.clipId }, include: { project: true } });
  if (clip.workspaceId !== request.workspaceId || clip.project.workspaceId !== request.workspaceId ||
    clip.project.sourceVideoId !== sourceVideoId) throw new Error("EXPORT_RANGE_JOB_CHANGED");
  const state = await loadPinnedEditorState(tx, { clipId: job.clipId, editVersion: job.editVersion,
    defaults: { sourceVideoId, startMs: clip.startMs, endMs: clip.endMs } });
  if (state.source.videoId !== sourceVideoId) throw new Error("EXPORT_RANGE_SOURCE_CHANGED");
  const range = sourceIntervalSchema.parse({ startMs: state.source.startMs, endMs: state.source.endMs });
  const existing = await tx.exportRangeInput.findUnique({ where: { exportJobId: job.id } });
  if (existing) {
    if (existing.artifactId !== request.artifactId || existing.editVersion !== job.editVersion ||
      existing.startMs !== BigInt(range.startMs) || existing.endMs !== BigInt(range.endMs)) throw new Error("EXPORT_RANGE_INPUT_CONFLICT");
    return existing;
  }
  if (job.state !== "QUEUED" || job.attempt !== 0) throw new Error("EXPORT_RANGE_JOB_ALREADY_STARTED");
  await tx.$queryRaw`SELECT id FROM derived_media_artifacts WHERE id=${request.artifactId}::uuid FOR SHARE`;
  const artifact = await tx.derivedMediaArtifact.findUnique({ where: { id: request.artifactId } });
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!artifact || artifact.sourceVideoId !== sourceVideoId || artifact.kind !== "CANDIDATE_RANGE" ||
    artifact.publicationState !== "READY" || artifact.visualQuality !== "ACCEPTED" || artifact.deletedAt ||
    artifact.mappingStatus !== "VERIFIED" || !artifact.mappingEvidenceSha256 ||
    (artifact.expiresAt && artifact.expiresAt <= now) || artifact.startMs > BigInt(range.startMs) || artifact.endMs < BigInt(range.endMs)) {
    throw new Error("EXPORT_RANGE_ARTIFACT_NOT_APPROVED_OR_COVERED");
  }
  const review = await tx.mediaArtifactReview.findFirst({ where: { artifactId: artifact.id }, orderBy: { revision: "desc" } });
  if (!review || review.decision !== "ACCEPTED" || review.artifactSha256 !== artifact.sha256 ||
    review.sourceSha256 !== artifact.sourceSha256 || review.mappingEvidenceSha256 !== artifact.mappingEvidenceSha256) {
    throw new Error("EXPORT_RANGE_REVIEW_REQUIRED");
  }
  return tx.exportRangeInput.create({ data: { exportJobId: job.id, artifactId: artifact.id, reviewId: review.id,
    sourceVideoId, sourceSha256: artifact.sourceSha256, artifactSha256: artifact.sha256,
    mappingEvidenceSha256: artifact.mappingEvidenceSha256, editVersion: job.editVersion!,
    startMs: BigInt(range.startMs), endMs: BigInt(range.endMs) } });
}

/** Explicit preparation helper for controlled local use. This does not enqueue or activate range exports. */
export function prepareExportRangeInput(prisma: PrismaClient, request: ExportRangePinRequest) {
  return prisma.$transaction(tx => pinExportRangeInput(tx, request));
}

const enqueueSchema = z.object({
  workspaceId: z.string().uuid(), clipId: z.string().uuid(), artifactId: z.string().uuid(),
  filename: z.string().min(1), editVersion: z.number().int().nonnegative().safe(),
  priority: z.number().int().min(-2147483648).max(2147483647).optional(),
}).strict();
export type RangeExportEnqueueRequest = z.infer<typeof enqueueSchema>;

/** Creates the job and pin in the caller's transaction. Never converts an existing original export. */
export async function enqueueRangeExportJobInTransaction(tx: Prisma.TransactionClient, input: RangeExportEnqueueRequest) {
  const request = enqueueSchema.parse(input);
  const clip = await tx.generatedClip.findUnique({ where: { id: request.clipId }, include: { project: true } });
  if (!clip || clip.workspaceId !== request.workspaceId || clip.project.workspaceId !== request.workspaceId ||
    !clip.project.sourceVideoId) throw new Error("EXPORT_RANGE_CLIP_NOT_FOUND");
  // Serialize range producers before creating a job that a worker could claim after commit.
  await lockMediaSource(tx, request.workspaceId, clip.project.sourceVideoId);
  const idempotencyKey = buildExportIdempotencyKey(request);
  let job = await tx.exportJob.findUnique({ where: { idempotencyKey } });
  if (job) {
    const pin = await tx.exportRangeInput.findUnique({ where: { exportJobId: job.id } });
    if (!pin) throw new Error("EXPORT_RANGE_EXISTING_ORIGINAL_JOB");
  } else {
    // A legacy producer race can fail this transaction. Do not query inside an aborted transaction.
    job = await tx.exportJob.create({ data: { workspaceId: request.workspaceId, clipId: request.clipId,
      filename: request.filename, editVersion: request.editVersion, priority: request.priority ?? 0,
      idempotencyKey, state: "QUEUED" } });
  }
  const pin = await pinExportRangeInput(tx, { workspaceId: request.workspaceId,
    exportJobId: job.id, artifactId: request.artifactId });
  return { job, pin };
}

/** Atomic standalone producer. Activation remains a separate worker setting. */
export function enqueueRangeExportJob(prisma: PrismaClient, request: RangeExportEnqueueRequest) {
  return prisma.$transaction(tx => enqueueRangeExportJobInTransaction(tx, request));
}

export class ExportRangeUnavailableError extends Error {
  constructor() { super("EXPORT_RANGE_UNAVAILABLE"); this.name = "ExportRangeUnavailableError"; }
}

/** Selects the smallest approved covering range, then creates both records atomically. */
export async function enqueueApprovedRangeExportInTransaction(tx: Prisma.TransactionClient,
  input: Omit<RangeExportEnqueueRequest, "artifactId">) {
  const request = enqueueSchema.omit({ artifactId: true }).parse(input);
  const initial = await tx.generatedClip.findUnique({ where: { id: request.clipId }, include: { project: true } });
  if (!initial || initial.workspaceId !== request.workspaceId || initial.project.workspaceId !== request.workspaceId ||
    !initial.project.sourceVideoId) throw new ExportRangeUnavailableError();
  const sourceVideoId = initial.project.sourceVideoId;
  await lockMediaSource(tx, request.workspaceId, sourceVideoId);
  const existing = await tx.exportJob.findUnique({ where: { idempotencyKey: buildExportIdempotencyKey(request) },
    include: { rangeInput: true } });
  if (existing) {
    if (!existing.rangeInput) throw new ExportRangeUnavailableError();
    return enqueueRangeExportJobInTransaction(tx, { ...request, artifactId: existing.rangeInput.artifactId });
  }
  const clip = await tx.generatedClip.findUniqueOrThrow({ where: { id: request.clipId }, include: { project: true } });
  if (clip.workspaceId !== request.workspaceId || clip.project.workspaceId !== request.workspaceId ||
    clip.project.sourceVideoId !== sourceVideoId) throw new ExportRangeUnavailableError();
  const state = await loadPinnedEditorState(tx, { clipId: clip.id, editVersion: request.editVersion,
    defaults: { sourceVideoId, startMs: clip.startMs, endMs: clip.endMs } });
  if (state.source.videoId !== sourceVideoId) throw new ExportRangeUnavailableError();
  const range = sourceIntervalSchema.parse({ startMs: state.source.startMs, endMs: state.source.endMs });
  const artifact = await findApprovedCoveringRange(tx, sourceVideoId, range);
  if (!artifact) throw new ExportRangeUnavailableError();
  // Pin admission rechecks the latest review and media identity under locks.
  return enqueueRangeExportJobInTransaction(tx, { ...request, artifactId: artifact.id });
}

/** The smallest approved candidate range that covers the interval. Pin admission still rechecks the latest review. */
export async function findApprovedCoveringRange(tx: Prisma.TransactionClient, sourceVideoId: string,
  range: { startMs: number; endMs: number }) {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return tx.derivedMediaArtifact.findFirst({ where: {
    sourceVideoId, kind: "CANDIDATE_RANGE", publicationState: "READY", mappingStatus: "VERIFIED",
    visualQuality: "ACCEPTED", retentionClass: "RENDER_SOURCE", deletedAt: null,
    mappingEvidenceSha256: { not: null }, startMs: { lte: BigInt(range.startMs) }, endMs: { gte: BigInt(range.endMs) },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    reviews: { some: { decision: "ACCEPTED" } },
  }, orderBy: [{ byteCount: "asc" }, { id: "asc" }] });
}
