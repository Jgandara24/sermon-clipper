import { ProcessingJobType, type PrismaClient } from "@prisma/client";
import { assertSourceReanalysisAllowed } from "@/lib/analysis/reanalysis-policy";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import type { ProcessingCostFactInput } from "@/lib/cost/types";
import { enqueueJob } from "@/lib/jobs/queue";
import { measurePublicationStorage, type PublicationStorageAccounting } from "@/lib/storage/measured-publication";
import type { StorageProvider } from "@/lib/storage/types";
import { runAnalysisDerivativeBatch, type AnalysisBatchRetention } from "./analysis-batch";
import type { AnalysisDerivativeSettings } from "./analysis-derivatives";
import type { LocalEvidenceSettings } from "./local-evidence";
import { measurePreparation } from "./preparation-measurement";
import type { SourceLeaseRequest } from "./source-lease";

/**
 * Derivative-first preparation for a project whose transcript is an uploaded SRT.
 * One source acquisition builds the shared audio, proxy, and local evidence. No speech provider runs:
 * the uploaded SRT stays the transcript, and the existing TRANSCRIBE job parses it after the lease ends.
 */
export async function prepareSrtSource(prisma: PrismaClient, storage: StorageProvider, input: {
  request: SourceLeaseRequest; projectId: string; derivatives: AnalysisDerivativeSettings;
  retention: AnalysisBatchRetention; localEvidence: LocalEvidenceSettings; storageAccounting: PublicationStorageAccounting;
}) {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, include: { sourceVideo: true } });
  if (!project || project.workspaceId !== input.request.workspaceId || project.sourceVideoId !== input.request.sourceVideoId) {
    throw new Error("SRT_PREPARATION_PROJECT_NOT_FOUND");
  }
  const srtKey = project.sourceVideo?.srtOverrideKey;
  if (!srtKey) throw new Error("SRT_PREPARATION_SRT_REQUIRED");
  // Refuse before acquiring the original: a missing transcript file would leave derivatives with nothing to analyze.
  if (!(await storage.exists(srtKey))) throw new Error("SRT_PREPARATION_SRT_MISSING");
  await assertSourceReanalysisAllowed(prisma, { sourceVideoId: input.request.sourceVideoId });
  const record = (fact: ProcessingCostFactInput) => recordProcessingCostFactSafely(prisma, {
    ...fact, workspaceId: project.workspaceId, projectId: project.id,
    details: { ...fact.details, sourceVideoId: input.request.sourceVideoId, scope: "srt_preparation" } });
  const batch = await runAnalysisDerivativeBatch(prisma, measurePublicationStorage(storage, input.storageAccounting, record),
    input.request, input.derivatives, input.retention, input.localEvidence, undefined, undefined,
    measurePreparation(input.storageAccounting.attempt, record));
  // Hand off only after every local reader, writer, and source-lease cleanup has finished.
  const transcribe = await enqueueJob(prisma, { projectId: project.id, type: ProcessingJobType.TRANSCRIBE,
    idempotencyKey: `transcribe:${project.id}` });
  return { batch, transcribeJobId: transcribe.id, srtKey };
}
