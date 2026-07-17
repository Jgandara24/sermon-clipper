import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { approvalExportBlockMessage, isClipApprovedForExport } from "@/lib/approval";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { enqueueExportJob } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { checkExportJobLimits } from "@/lib/rate-limit";

const postBodySchema = z.object({
  filename: z.string().trim().min(1).max(200).optional(),
});

/** Enqueues an export job for a clip (guide §15/§19). Idempotent per (clip, edit version, filename). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace("EXPORT_CLIP");
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const clip = await prisma.generatedClip.findUnique({
    where: { id },
    include: { project: true, approvals: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!clip) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(clip.workspaceId, auth.workspace.id, "clip");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const json = await request.json().catch(() => ({}));
  const parsed = postBodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "That export request couldn't be read.");
  }

  const approvalState = clip.approvals[0]?.state ?? null;
  if (!isClipApprovedForExport(approvalState)) {
    return apiError("APPROVAL_REQUIRED", approvalExportBlockMessage(approvalState), {
      status: 409,
    });
  }

  const latestEdit = await prisma.clipEdit.findFirst({
    where: { clipId: id },
    orderBy: { version: "desc" },
  });
  const editVersion = latestEdit?.version ?? 0;

  const filename =
    parsed.data.filename ??
    buildDefaultExportFilename({
      seriesOrProject: clip.project.series ?? clip.project.name,
      clipTitle: clip.title,
      date: new Date(),
    });
  const idempotencyKey = `export:${clip.id}:v${editVersion}:${filename}`;

  // Idempotent re-requests of an existing job bypass rate limits — they create no new render.
  // Only genuinely new jobs (including filename variations, the unlimited-render loophole)
  // count against the workspace's concurrent and daily caps.
  const existing = await prisma.exportJob.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return apiData({ exportJobId: existing.id });
  }

  const limit = await checkExportJobLimits(prisma, auth.workspace.id);
  if (!limit.allowed) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: auth.workspace.id,
      category: "export",
      eventType: "export_rejected_rate_limited",
      severity: "warning",
      message: "Export request rejected by workspace rate limits.",
      metadata: { clipId: clip.id, reason: limit.reason, limit: limit.limit, current: limit.current },
    });
    return apiError("RATE_LIMITED", limit.message, { status: 429, retryable: true });
  }

  const job = await enqueueExportJob(prisma, {
    clipId: clip.id,
    workspaceId: auth.workspace.id,
    filename,
    idempotencyKey,
  });

  return apiData({ exportJobId: job.id });
}
