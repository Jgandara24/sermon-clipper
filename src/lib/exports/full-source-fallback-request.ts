import type { PrismaClient } from "@prisma/client";
import { CLIP_TRANSCRIPT_CHANGED, CLIP_TRANSCRIPT_CHANGED_MESSAGE, isClipTranscriptChanged } from "@/lib/analysis/source-write-boundary";
import type { EditorState } from "@/lib/editor/types";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { checkExportJobLimits } from "@/lib/rate-limit";
import { assessFinalRender, FINAL_RENDER_REFUSED } from "@/lib/review/final-render-eligibility";
import { clipRendersContinuousRange, CONTINUOUS_RANGE_MESSAGE, CONTINUOUS_RANGE_REQUIRED } from "./continuous-range";
import { DEFAULT_EDIT_VERSION } from "./edit-version";
import { enqueueFullSourceFallbackExport, FullSourceFallbackError } from "./full-source-fallback";

export const FULL_SOURCE_FALLBACK_REFUSALS: Record<string, string> = {
  FULL_SOURCE_FALLBACK_RANGE_EXPORTS_DISABLED: "Range exports are not active, so no fallback is needed.",
  FULL_SOURCE_FALLBACK_DISABLED: "Full-source export fallback is not enabled.",
  FULL_SOURCE_FALLBACK_RANGE_AVAILABLE: "An approved media range covers this clip. Use the normal export.",
  FULL_SOURCE_FALLBACK_ORIGINAL_UNAVAILABLE: "The original source file is no longer stored.",
  FULL_SOURCE_FALLBACK_EXISTING_JOB: "This clip version already has a different export.",
  FULL_SOURCE_FALLBACK_SOURCE_CHANGED: "The saved clip no longer matches its source.",
  FULL_SOURCE_FALLBACK_CLIP_NOT_FOUND: "That clip was not found.",
};

export type FullSourceFallbackRequestOutcome =
  | { ok: true; created: boolean; exportJobId: string; fullSourceFallbackId: string; editorialExceptionId: string }
  | { ok: false; status: number; code: string; message: string; retryable?: boolean };

/**
 * The one operator entry for a full-source fallback, shared by the API route and the operator page.
 * The caller must already have proved platform-operator authority. Delivery rules still apply.
 */
export async function requestFullSourceFallback(prisma: PrismaClient,
  input: { clipId: string; operatorUserId: string; reason: string }): Promise<FullSourceFallbackRequestOutcome> {
  const clip = await prisma.generatedClip.findUnique({ where: { id: input.clipId }, include: { project: true } });
  if (!clip) return { ok: false, status: 404, code: "NOT_FOUND", message: "That clip was not found." };
  const latestEdit = await prisma.clipEdit.findFirst({ where: { clipId: clip.id }, orderBy: { version: "desc" } });
  const editVersion = latestEdit?.version ?? DEFAULT_EDIT_VERSION;
  // The worker checks these again. The fallback changes the media input, not the delivery rules.
  if (clip.project.sourceVideoId && !(await clipRendersContinuousRange(prisma, { sourceVideoId: clip.project.sourceVideoId,
    state: latestEdit?.editorState as EditorState | undefined }))) {
    return { ok: false, status: 409, code: CONTINUOUS_RANGE_REQUIRED, message: CONTINUOUS_RANGE_MESSAGE };
  }
  const finalRender = await assessFinalRender(prisma, { clipId: clip.id });
  if (!finalRender.allowed) return { ok: false, status: 409, code: FINAL_RENDER_REFUSED, message: finalRender.message };
  const limit = await checkExportJobLimits(prisma, clip.workspaceId);
  if (!limit.allowed) return { ok: false, status: 429, code: "RATE_LIMITED", message: limit.message, retryable: true };
  try {
    const result = await enqueueFullSourceFallbackExport(prisma, {
      workspaceId: clip.workspaceId, clipId: clip.id, requestedByUserId: input.operatorUserId, editVersion, reason: input.reason,
      filename: buildDefaultExportFilename({ seriesOrProject: clip.project.series ?? clip.project.name, clipTitle: clip.title, date: new Date() }),
    });
    if (result.created) {
      await recordOperationalEventSafely(prisma, { workspaceId: clip.workspaceId, category: "export",
        eventType: "export_full_source_fallback_requested", severity: "warning",
        message: "An operator requested a full-source export fallback.", clipId: clip.id, exportJobId: result.job.id,
        metadata: { fullSourceFallbackId: result.fallback.id, editorialExceptionId: result.exception.id, editVersion } });
    }
    return { ok: true, created: result.created, exportJobId: result.job.id, fullSourceFallbackId: result.fallback.id,
      editorialExceptionId: result.exception.id };
  } catch (error) {
    if (error instanceof FullSourceFallbackError) {
      return { ok: false, status: 409, code: error.code, message: FULL_SOURCE_FALLBACK_REFUSALS[error.code] ?? "The fallback request was refused." };
    }
    if (isClipTranscriptChanged(error)) {
      return { ok: false, status: 409, code: CLIP_TRANSCRIPT_CHANGED, message: CLIP_TRANSCRIPT_CHANGED_MESSAGE };
    }
    throw error;
  }
}
