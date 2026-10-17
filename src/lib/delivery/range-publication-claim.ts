import { readOriginalRenderEvidence } from "@/lib/exports/original-render-evidence";
import type { PrismaClient } from "@prisma/client";
import { assertOriginalRegionExportAllowed, assertRegionExportAllowed } from "@/lib/media-regions/export-policy";
import { ExportFailureError } from "@/lib/exports/errors";
import { recordPublishIntent } from "./publish-attempts";
import type { DeliveryIneligibleReason } from "./eligibility";

/** Call after delivery eligibility. Serializes the final region check, exact slot claim, and intent record. */
export async function claimSourcePublication(client: PrismaClient, input: {
  workspaceId: string; scheduledPostId: string; clipId: string; exportJobId: string; now: Date;
}): Promise<{ status: "CLAIMED"; attemptId: string } | { status: "LOST" } |
  { status: "INELIGIBLE"; reason: DeliveryIneligibleReason }> {
  return client.$transaction(async tx => {
    const pin = await tx.exportRangeInput.findUnique({ where: { exportJobId: input.exportJobId }, include: { exportJob: true } });
    const job = pin?.exportJob ?? await tx.exportJob.findUnique({ where: { id: input.exportJobId } });
    if (!job || job.workspaceId !== input.workspaceId || job.clipId !== input.clipId) {
      return { status: "INELIGIBLE", reason: "source_region_check_unavailable" };
    }
    if (job.state !== "SUCCEEDED") return { status: "INELIGIBLE", reason: "export_not_succeeded" };
    const original = pin ? null : readOriginalRenderEvidence(job.qcDetails, job.editVersion);
    const sourceVideoId = pin?.sourceVideoId ?? original?.sourceVideoId;
    if (!sourceVideoId) return { status: "INELIGIBLE", reason: "source_region_check_unavailable" };
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${sourceVideoId}::uuid FOR UPDATE`;
    try {
      if (pin) await assertRegionExportAllowed(tx, { workspaceId: input.workspaceId, sourceVideoId,
        sourceSha256: pin.sourceSha256, sourceInterval: { startMs: Number(pin.startMs), endMs: Number(pin.endMs) } });
      else await assertOriginalRegionExportAllowed(tx, { workspaceId: input.workspaceId, sourceVideoId,
        sourceInterval: original!.sourceInterval });
    } catch (error) {
      if (!(error instanceof ExportFailureError)) throw error;
      return { status: "INELIGIBLE", reason: error.code === "EXPORT_FORBIDDEN_REGION"
        ? "source_region_forbidden" : "source_region_check_unavailable" };
    }
    const claim = await tx.scheduledPost.updateMany({ where: { id: input.scheduledPostId, workspaceId: input.workspaceId,
      clipId: input.clipId, exportJobId: input.exportJobId, publishStatus: "NOT_STARTED" }, data: { publishStatus: "IN_PROGRESS" } });
    if (claim.count === 0) return { status: "LOST" };
    const attemptId = await recordPublishIntent(tx, { scheduledPostId: input.scheduledPostId,
      expectedClipId: input.clipId, expectedExportJobId: input.exportJobId, now: input.now });
    return { status: "CLAIMED", attemptId };
  });
}

/** Compatibility name retained for existing range-export callers. */
export const claimRangePublication = claimSourcePublication;
