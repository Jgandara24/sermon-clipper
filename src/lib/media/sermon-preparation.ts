import { JobFailureError } from "@/lib/jobs/types";
import { BoundaryAsrUnresolvedError, type BoundaryAsrBatchRequest } from "./boundary-asr-batch";
import type { ProxyViewPlanRequest } from "./proxy-view-sampling";
import { assertSourceReanalysisAllowed } from "@/lib/analysis/reanalysis-policy";
import { measurePreparation } from "./preparation-measurement";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { measurePublicationStorage, type PublicationStorageAccounting } from "@/lib/storage/measured-publication";
import type { StorageProvider } from "@/lib/storage/types";
import type { TranscriptionProvider } from "@/lib/transcription/types";
import { transcribeRegisteredSermonAudio } from "@/lib/transcription/registered-sermon";
import { buildSubmissionTranscriptStructure, persistSermonSubmission } from "@/lib/transcription/persist-submission";
import { transcriptBoundarySettingsSchema } from "@/lib/transcription/boundaries";
import { audioEvidenceSettingsSchema, type AudioEvidenceSettings } from "./audio-evidence";
import { runAnalysisDerivativeBatch, type AnalysisBatchOcrRequest, type AnalysisBatchRetention, type AnalysisBatchSermonRequest } from "./analysis-batch";
import type { AnalysisDerivativeSettings } from "./analysis-derivatives";
import type { LocalEvidenceSettings } from "./local-evidence";
import type { SourceLeaseRequest } from "./source-lease";

/** Explicit-corridor coordinator. Production policy must select the corridor before invoking this path. */
export async function prepareSermonSource(prisma: PrismaClient, storage: StorageProvider, input: {
  request: SourceLeaseRequest; projectId: string; derivatives: AnalysisDerivativeSettings;
  retention: AnalysisBatchRetention; localEvidence: LocalEvidenceSettings; sermon: AnalysisBatchSermonRequest;
  structureAudio: AudioEvidenceSettings; structureBoundaries: z.infer<typeof transcriptBoundarySettingsSchema>;
  provider: TranscriptionProvider; language?: string; storageAccounting: PublicationStorageAccounting; views?: ProxyViewPlanRequest[];
  ocr?: AnalysisBatchOcrRequest; boundaryAsr?: BoundaryAsrBatchRequest;
}) {
  const structureAudio = audioEvidenceSettingsSchema.parse(input.structureAudio);
  const structureBoundaries = transcriptBoundarySettingsSchema.parse(input.structureBoundaries);
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project || project.workspaceId !== input.request.workspaceId || project.sourceVideoId !== input.request.sourceVideoId) {
    throw new Error("SERMON_PREPARATION_PROJECT_NOT_FOUND");
  }
  const boundaryReview = await prisma.editorialException.findFirst({ where: { projectId: project.id,
    exceptionType: "SERMON_PREPARATION_REQUIRED", state: "OPEN", AND: [
      { metadata: { path: ["boundaryStatus"], equals: "AMBIGUOUS" } },
      { metadata: { path: ["sourceVideoId"], equals: input.request.sourceVideoId } },
    ] } });
  if (boundaryReview) throw new JobFailureError("SERMON_PREPARATION_REQUIRED",
    "Sermon boundaries remain ambiguous. Review the preparation exception before another attempt.", { retryable: false });
  await assertSourceReanalysisAllowed(prisma, { sourceVideoId: input.request.sourceVideoId });
  if (input.provider.name !== "elevenlabs_scribe_v2" || !await input.provider.isAvailable()) {
    throw new Error("SERMON_PREPARATION_PROVIDER_UNAVAILABLE");
  }
  const measuredStorage = measurePublicationStorage(storage, input.storageAccounting, fact =>
    recordProcessingCostFactSafely(prisma, { ...fact, workspaceId: project.workspaceId, projectId: project.id,
      details: { ...fact.details, sourceVideoId: input.request.sourceVideoId, scope: "sermon_preparation" } }));
  const measure = measurePreparation(input.storageAccounting.attempt, fact =>
    recordProcessingCostFactSafely(prisma, { ...fact, workspaceId: project.workspaceId, projectId: project.id,
      details: { ...fact.details, sourceVideoId: input.request.sourceVideoId, scope: "sermon_preparation" } }));
  const batch = await runAnalysisDerivativeBatch(prisma, measuredStorage, input.request, input.derivatives, input.retention,
    input.localEvidence, input.sermon, async ({ source, analysis, audio, artifact }) => {
      const submission = await transcribeRegisteredSermonAudio(prisma, { workspaceId: input.request.workspaceId,
        sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, artifactId: artifact.id,
        sessionId: source.sessionId, ownerId: input.request.ownerId, analysis, audio,
        provider: input.provider, language: input.language });
      const structure = await measure("transcript_structure", () => buildSubmissionTranscriptStructure(prisma, { workspaceId: input.request.workspaceId,
        submissionId: submission.submissionId, audioPath: audio.path, byteCount: audio.byteCount,
        audioSettings: structureAudio, boundarySettings: structureBoundaries }));
      return { submissionId: submission.submissionId, reused: submission.reused, structure };
    }, measure, input.views, input.ocr, input.boundaryAsr).catch(async error => {
      if (!(error instanceof BoundaryAsrUnresolvedError)) throw error;
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id}::uuid FOR UPDATE`;
        const existing = await tx.editorialException.findFirst({ where: { projectId: project.id,
          exceptionType: "SERMON_PREPARATION_REQUIRED", state: "OPEN", AND: [
            { metadata: { path: ["boundaryStatus"], equals: "AMBIGUOUS" } },
            { metadata: { path: ["sourceVideoId"], equals: input.request.sourceVideoId } },
          ] } });
        if (!existing) await tx.editorialException.create({ data: { workspaceId: project.workspaceId,
          projectId: project.id, exceptionType: "SERMON_PREPARATION_REQUIRED",
          message: "Sermon boundaries remain ambiguous. Review the stored sampling evidence before another attempt.",
          projectSnapshot: { id: project.id, name: project.name, sourceVideoId: project.sourceVideoId },
          metadata: { samplingArtifactId: error.samplingArtifactId, decisionArtifactId: error.decisionArtifactId,
            sourceVideoId: input.request.sourceVideoId, boundaryStatus: "AMBIGUOUS", visualEscalationId: error.visualEscalationId,
            automaticRetry: false, fullSourceFallback: false },
        } });
      });
      throw new JobFailureError("SERMON_PREPARATION_REQUIRED",
        "Sermon boundaries remain ambiguous. Review the preparation exception before another attempt.",
        { cause: error, retryable: false });
    });
  if (!batch.consumption) throw new Error("SERMON_PREPARATION_SUBMISSION_MISSING");
  // Queue analysis only after all local readers, writers, and source-lease cleanup have completed.
  const transcript = await persistSermonSubmission(prisma, { workspaceId: input.request.workspaceId,
    projectId: input.projectId, submissionId: batch.consumption.submissionId, structure: batch.consumption.structure });
  return { batch, transcript };
}
