import type { DerivedMediaArtifact, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";

const requestSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  artifactId: z.string().uuid(), sessionId: z.string().uuid(), ownerId: z.string().uuid(),
  language: z.string().trim().min(1).optional() }).strict();
export type SermonSubmissionRequest = z.infer<typeof requestSchema>;

/** Await within the owning source lease. An uncertain request never automatically runs again. */
export async function runSermonSubmissionOnce(prisma: PrismaClient, input: SermonSubmissionRequest,
  submit: (admission: { submissionId: string; artifact: DerivedMediaArtifact }) => Promise<Prisma.InputJsonObject>) {
  const request = requestSchema.parse(input);
  const admission = await prisma.$transaction(async tx => {
    await lockMediaSource(tx, request.workspaceId, request.sourceVideoId);
    const sessions = await tx.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM source_media_sessions s JOIN source_media_gates g ON g.source_id=s.source_id AND g.generation=s.generation
      WHERE s.id=${request.sessionId}::uuid AND s.source_id=${request.sourceVideoId}::uuid
      AND s.owner_id=${request.ownerId}::uuid AND s.state='ACTIVE' AND s.purpose='P4_DERIVATIVE_BUILD' AND g.state='ACTIVE'
      FOR UPDATE OF s`;
    if (sessions.length !== 1) throw new Error("SERMON_SUBMISSION_OWNER_REQUIRED");
    const source = await tx.sourceVideo.findUniqueOrThrow({ where: { id: request.sourceVideoId } });
    const artifact = await tx.derivedMediaArtifact.findUnique({ where: { id: request.artifactId } });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!artifact || artifact.sourceVideoId !== request.sourceVideoId || artifact.kind !== "SERMON_AUDIO" ||
      artifact.publicationState !== "READY" || artifact.mappingStatus !== "VERIFIED" || !artifact.mappingEvidenceSha256 ||
      artifact.deletedAt || (artifact.expiresAt && artifact.expiresAt <= now)) throw new Error("SERMON_SUBMISSION_ARTIFACT_INVALID");
    const evidence = { version: "sermon-submission-v1", sourceVideoId: request.sourceVideoId,
      sourceSha256: artifact.sourceSha256, artifactId: artifact.id, audioSha256: artifact.sha256,
      byteCount: artifact.byteCount.toString(), mappingEvidenceSha256: artifact.mappingEvidenceSha256,
      startMs: artifact.startMs.toString(), endMs: artifact.endMs.toString(),
      provider: "elevenlabs", model: "scribe_v2", language: request.language ?? "auto", keyterms: [], noVerbatim: false };
    const requestIdentity = rangeEvidenceSha256(evidence);
    const existing = await tx.sermonTranscriptionSubmission.findUnique({ where: { requestIdentity } });
    if (existing) return { row: existing, created: false, artifact };
    if (await tx.sermonTranscriptionSubmission.findFirst({ where: { sourceVideoId: request.sourceVideoId,
      state: { in: ["STARTED", "UNCERTAIN"] } } })) throw new Error("SERMON_SUBMISSION_SOURCE_UNCERTAIN");
    const row = await tx.sermonTranscriptionSubmission.create({ data: { sourceVideoId: request.sourceVideoId,
      artifactId: artifact.id, requestIdentity, requestEvidence: { ...evidence, transcriptRevision: source.transcriptRevision, sourceUpdatedAt: source.updatedAt.toISOString() } } });
    return { row, created: true, artifact };
  });
  if (!admission.created) {
    if (admission.row.state !== "COMPLETED") throw new Error("SERMON_SUBMISSION_UNCERTAIN");
    if (!admission.row.result || rangeEvidenceSha256(admission.row.result) !== admission.row.resultSha256) {
      throw new Error("SERMON_SUBMISSION_RESULT_CHANGED");
    }
    return { submissionId: admission.row.id, reused: true, result: admission.row.result };
  }
  try {
    const result = await submit({ submissionId: admission.row.id, artifact: admission.artifact });
    const resultSha256 = rangeEvidenceSha256(result);
    const row = await prisma.sermonTranscriptionSubmission.update({ where: { id: admission.row.id },
      data: { state: "COMPLETED", result, resultSha256, finishedAt: new Date() } });
    return { submissionId: row.id, reused: false, result: row.result! };
  } catch (error) {
    // If completion committed but its reply was lost, this update cannot overwrite it.
    await prisma.sermonTranscriptionSubmission.updateMany({ where: { id: admission.row.id, state: "STARTED" },
      data: { state: "UNCERTAIN", finishedAt: new Date() } });
    throw error;
  }
}
