import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256Schema } from "./types";
import { lockMediaSource } from "./persistence";

const requestSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  artifactId: z.string().uuid(), reviewerId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(["ACCEPTED", "REJECTED"]), sourceSha256: sha256Schema, artifactSha256: sha256Schema,
  mappingEvidenceSha256: sha256Schema, evidence: z.object({
    comparisonReference: z.string().trim().min(1).max(2000), notes: z.string().trim().min(1).max(10000),
    fullRangeCompared: z.boolean(), dimensionsChecked: z.boolean(), timingChecked: z.boolean(),
    visualQualityAcceptable: z.boolean(),
  }).strict() }).strict();
export type ArtifactReviewRequest = z.infer<typeof requestSchema>;

/** Records an actual reviewer decision. This function does not perform a review or infer approval. */
export async function recordArtifactReview(prisma: PrismaClient, input: ArtifactReviewRequest) {
  const request = requestSchema.parse(input);
  if (request.decision === "ACCEPTED" && (!request.evidence.fullRangeCompared || !request.evidence.dimensionsChecked ||
    !request.evidence.timingChecked || !request.evidence.visualQualityAcceptable)) throw new Error("MEDIA_ARTIFACT_REVIEW_INCOMPLETE");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id=${request.workspaceId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM workspace_members WHERE workspace_id=${request.workspaceId}::uuid
      AND user_id=${request.reviewerId}::uuid FOR SHARE`;
    const workspace = await tx.workspace.findUnique({ where: { id: request.workspaceId } });
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: {
      workspaceId: request.workspaceId, userId: request.reviewerId } } });
    if (!workspace || (workspace.ownerId !== request.reviewerId &&
      (!member || member.status !== "ACTIVE" || !["OWNER", "ADMIN", "APPROVER"].includes(member.role)))) {
      throw new Error("MEDIA_ARTIFACT_REVIEW_NOT_AUTHORIZED");
    }
    await lockMediaSource(tx, request.workspaceId, request.sourceVideoId);
    if (await tx.sourceMediaSession.findFirst({ where: { sourceId: request.sourceVideoId, state: { not: "COMPLETE" } } })) {
      throw new Error("MEDIA_SOURCE_SESSION_UNFINISHED");
    }
    await tx.$queryRaw`SELECT id FROM derived_media_artifacts WHERE id=${request.artifactId}::uuid FOR UPDATE`;
    const artifact = await tx.derivedMediaArtifact.findUnique({ where: { id: request.artifactId } });
    if (!artifact || artifact.sourceVideoId !== request.sourceVideoId || artifact.kind !== "CANDIDATE_RANGE" ||
      artifact.publicationState !== "READY" || artifact.mappingStatus !== "VERIFIED" || artifact.deletedAt ||
      artifact.sourceSha256 !== request.sourceSha256 || artifact.sha256 !== request.artifactSha256 ||
      artifact.mappingEvidenceSha256 !== request.mappingEvidenceSha256) throw new Error("MEDIA_ARTIFACT_REVIEW_BYTES_CHANGED");
    const previous = await tx.mediaArtifactReview.findFirst({ where: { artifactId: artifact.id }, orderBy: { revision: "desc" } });
    if ((previous?.revision ?? 0) !== request.expectedRevision) throw new Error("MEDIA_ARTIFACT_REVIEW_REVISION_CHANGED");
    const review = await tx.mediaArtifactReview.create({ data: { artifactId: artifact.id,
      revision: request.expectedRevision + 1, reviewerId: request.reviewerId, decision: request.decision,
      sourceSha256: request.sourceSha256, artifactSha256: request.artifactSha256,
      mappingEvidenceSha256: request.mappingEvidenceSha256, evidence: request.evidence } });
    await tx.derivedMediaArtifact.update({ where: { id: artifact.id }, data: { visualQuality: request.decision } });
    return review;
  });
}
