import { readOriginalRenderEvidence } from "@/lib/exports/original-render-evidence";
import type { MediaRegion, Prisma } from "@prisma/client";
import { regionBlocksVideo } from "./video-policy";

export const LATE_REGION_EXCEPTION = "SOURCE_REGION_CHANGED_AFTER_CLAIM";

/** Caller holds the source lock. Preserve remote publication history and attach actionable local evidence. */
export async function recordLateRegionExceptions(tx: Prisma.TransactionClient, workspaceId: string, region: MediaRegion) {
  if (!regionBlocksVideo(region.kind)) return;
  const posts = await tx.scheduledPost.findMany({ where: { workspaceId,
    publishStatus: { in: ["IN_PROGRESS", "SUCCEEDED"] },
    exportJob: { OR: [
      { rangeInput: { sourceVideoId: region.sourceVideoId, sourceSha256: region.sourceSha256,
        startMs: { lt: region.endMs }, endMs: { gt: region.startMs } } },
      { rangeInput: null, OR: [
        { qcDetails: { path: ["mediaInput", "sourceVideoId"], equals: region.sourceVideoId } },
        { clip: { project: { sourceVideoId: region.sourceVideoId } } },
      ] },
    ] },
  }, select: { id: true, projectId: true, clipId: true, exportJobId: true, publishStatus: true,
    facebookPostId: true, scheduledDate: true, exportJob: { select: { qcDetails: true, editVersion: true, rangeInput: { select: { sourceVideoId: true } } } }, project: { select: { name: true } } } });
  for (const post of posts) {
    const original = post.exportJob && !post.exportJob.rangeInput
      ? readOriginalRenderEvidence(post.exportJob.qcDetails, post.exportJob.editVersion) : null;
    if (original && (original.sourceVideoId !== region.sourceVideoId ||
      BigInt(original.sourceInterval.startMs) >= region.endMs || BigInt(original.sourceInterval.endMs) <= region.startMs)) continue;
    // Missing original evidence cannot establish non-overlap. Keep the historical post for human review.
    // Resolved exceptions also count: the same immutable fact must not reopen a completed review.
    const existing = await tx.editorialException.findFirst({ where: { scheduledPostId: post.id,
      exceptionType: LATE_REGION_EXCEPTION, metadata: { path: ["regionId"], equals: region.id } }, select: { id: true } });
    if (existing) continue;
    await tx.editorialException.create({ data: { workspaceId, projectId: post.projectId, scheduledPostId: post.id,
      exceptionType: LATE_REGION_EXCEPTION,
      message: "New source evidence affects this publication. Review the post and its source interval.",
      projectSnapshot: { id: post.projectId, name: post.project?.name ?? null, sourceVideoId: region.sourceVideoId },
      slotSnapshot: { id: post.id, clipId: post.clipId, exportJobId: post.exportJobId, publishStatus: post.publishStatus,
        facebookPostId: post.facebookPostId, scheduledDate: post.scheduledDate.toISOString() },
      metadata: { regionId: region.id, regionIdentityKey: region.identityKey, sourceSha256: region.sourceSha256,
        regionKind: region.kind, startMs: region.startMs.toString(), endMs: region.endMs.toString(),
        evidenceSha256: region.evidenceSha256, providerActionTaken: false },
    } });
  }
}
