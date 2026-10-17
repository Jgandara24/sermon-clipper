import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { buildExportIdempotencyKey, loadPinnedEditorState } from "./edit-version";
import { findApprovedCoveringRange } from "./range-input";
import { rangeExportsEnabled } from "./range-policy";

export const FULL_SOURCE_FALLBACK_EXCEPTION_TYPE = "full_source_export_fallback";
export const FULL_SOURCE_FALLBACK_COST_INPUT = "FULL_SOURCE_FALLBACK";

/** Separate controlled activation. Never infer it from range exports, original presence, or a missing range. */
export function fullSourceExportFallbackEnabled(): boolean {
  return process.env.P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED === "true";
}

export class FullSourceFallbackError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FullSourceFallbackError"; }
}

const requestSchema = z.object({
  workspaceId: z.string().uuid(), clipId: z.string().uuid(), requestedByUserId: z.string().uuid(),
  filename: z.string().min(1), editVersion: z.number().int().nonnegative().safe(),
  reason: z.string().trim().min(1).max(500),
  priority: z.number().int().min(-2147483648).max(2147483647).optional(),
}).strict();
export type FullSourceFallbackRequest = z.input<typeof requestSchema>;

/**
 * Creates one original-input export, its open review exception, and its fallback record in the caller's transaction.
 * It refuses when an approved range covers the interval. It never converts an existing job.
 */
export async function enqueueFullSourceFallbackExportInTransaction(tx: Prisma.TransactionClient, input: FullSourceFallbackRequest) {
  const request = requestSchema.parse(input);
  if (!rangeExportsEnabled()) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_RANGE_EXPORTS_DISABLED");
  if (!fullSourceExportFallbackEnabled()) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_DISABLED");
  const initial = await tx.generatedClip.findUnique({ where: { id: request.clipId }, include: { project: true } });
  if (!initial || initial.workspaceId !== request.workspaceId || initial.project.workspaceId !== request.workspaceId ||
    !initial.project.sourceVideoId) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_CLIP_NOT_FOUND");
  const sourceVideoId = initial.project.sourceVideoId;
  // The same lock serializes range producers, so a range cannot appear between this check and job creation.
  await lockMediaSource(tx, request.workspaceId, sourceVideoId);
  const idempotencyKey = buildExportIdempotencyKey(request);
  const existing = await tx.exportJob.findUnique({ where: { idempotencyKey },
    include: { fullSourceFallback: { include: { editorialException: true } } } });
  if (existing) {
    if (!existing.fullSourceFallback) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_EXISTING_JOB");
    const { editorialException: exception, ...fallback } = existing.fullSourceFallback;
    return { job: existing, fallback, exception, created: false };
  }
  const clip = await tx.generatedClip.findUniqueOrThrow({ where: { id: request.clipId }, include: { project: true } });
  if (clip.workspaceId !== request.workspaceId || clip.project.workspaceId !== request.workspaceId ||
    clip.project.sourceVideoId !== sourceVideoId) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_CLIP_NOT_FOUND");
  const state = await loadPinnedEditorState(tx, { clipId: clip.id, editVersion: request.editVersion,
    defaults: { sourceVideoId, startMs: clip.startMs, endMs: clip.endMs } });
  if (state.source.videoId !== sourceVideoId) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_SOURCE_CHANGED");
  const range = sourceIntervalSchema.parse({ startMs: state.source.startMs, endMs: state.source.endMs });
  if (await findApprovedCoveringRange(tx, sourceVideoId, range)) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_RANGE_AVAILABLE");
  const source = await tx.sourceVideo.findUniqueOrThrow({ where: { id: sourceVideoId } });
  if (!source.storageKey) throw new FullSourceFallbackError("FULL_SOURCE_FALLBACK_ORIGINAL_UNAVAILABLE");
  const job = await tx.exportJob.create({ data: { workspaceId: request.workspaceId, clipId: clip.id,
    filename: request.filename, editVersion: request.editVersion, priority: request.priority ?? 0,
    idempotencyKey, state: "QUEUED" } });
  const sourceByteCount = source.sizeBytes ?? null;
  const exception = await tx.editorialException.create({ data: {
    workspaceId: request.workspaceId, projectId: clip.projectId, exceptionType: FULL_SOURCE_FALLBACK_EXCEPTION_TYPE,
    message: "This clip export reads the complete original because no approved range covers it.",
    metadata: { exportJobId: job.id, clipId: clip.id, sourceVideoId, editVersion: request.editVersion,
      sourceInterval: range, sourceByteCount: sourceByteCount === null ? null : sourceByteCount.toString(),
      reasonCode: "EXPORT_RANGE_UNAVAILABLE", reason: request.reason, requestedByUserId: request.requestedByUserId },
  } });
  const fallback = await tx.exportFullSourceFallback.create({ data: {
    exportJobId: job.id, workspaceId: request.workspaceId, sourceVideoId, editorialExceptionId: exception.id,
    requestedByUserId: request.requestedByUserId, reasonCode: "EXPORT_RANGE_UNAVAILABLE", reason: request.reason,
    editVersion: request.editVersion, startMs: BigInt(range.startMs), endMs: BigInt(range.endMs), sourceByteCount,
  } });
  return { job, fallback, exception, created: true };
}

/** Standalone atomic producer for operator requests. */
export function enqueueFullSourceFallbackExport(prisma: PrismaClient, request: FullSourceFallbackRequest) {
  return prisma.$transaction(tx => enqueueFullSourceFallbackExportInTransaction(tx, request));
}
