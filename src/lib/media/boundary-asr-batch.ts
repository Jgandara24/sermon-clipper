import { runVisualBoundaryEscalationOnce, type VisualEscalationRequest } from "./visual-escalation";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DerivedMediaArtifact, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { artifactIdentityKey, type ArtifactRecord } from "@/lib/media-artifacts/types";
import { publishMediaArtifact } from "@/lib/media-artifacts/publication";
import type { StorageProvider } from "@/lib/storage/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { boundaryAsrPlanSchema, boundaryAsrSettingsSchema, sampleAmbiguousBoundaries } from "./boundary-asr";
import { sermonCorridorSchema, type SermonAudioInput, type SermonCorridor } from "./sermon-audio";
import { rangeEvidenceSha256 } from "./range-evidence";
import type { PreparationMeasure } from "./preparation-measurement";

export const boundaryAsrResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("RESOLVED"), corridor: sermonCorridorSchema, reason: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal("AMBIGUOUS"), reason: z.string().trim().min(1) }).strict(),
]);
export const boundaryAsrBatchSettingsSchema = z.object({
  settings: boundaryAsrSettingsSchema,
  plan: boundaryAsrPlanSchema.omit({ sourceVideoId: true, sourceSha256: true, corridor: true }),
  maxDocumentBytes: z.number().int().positive().max(2147483647),
}).strict();
type EscalationImage = Pick<DerivedMediaArtifact, "id" | "kind" | "sha256" | "byteCount" | "startMs" | "endMs"> & {
  publicationEvidence?: DerivedMediaArtifact["publicationEvidence"];
};
type SamplingResult = Awaited<ReturnType<typeof sampleAmbiguousBoundaries>>;
export type BoundaryAsrBatchRequest = z.infer<typeof boundaryAsrBatchSettingsSchema> & {
  resolve: (context: { evidence: Omit<SamplingResult, "measurements">;
    artifactId: string; artifactSha256: string; initialCorridor: SermonCorridor }) => Promise<z.infer<typeof boundaryAsrResolutionSchema>>;
  prepareVisualEscalation?: (context: { sourceVideoId: string; sourceSha256: string;
    samplingEvidence: Omit<SamplingResult, "measurements">; initialCorridor: SermonCorridor;
    localDecisionArtifactId: string; localDecisionArtifactSha256: string; availableImages: EscalationImage[] }) => Promise<{
      request: Omit<VisualEscalationRequest, "workspaceId" | "sourceVideoId" | "sessionId" | "ownerId" | "boundaryDecisionArtifactId">;
      submit: Parameters<typeof runVisualBoundaryEscalationOnce>[2];
    }>;
};

export class BoundaryAsrUnresolvedError extends Error {
  constructor(readonly samplingArtifactId: string, readonly decisionArtifactId: string,
    readonly visualEscalationId: string | null = null, options?: ErrorOptions) {
    super("BOUNDARY_ASR_UNRESOLVED", options);
  }
}

/** Persist observations before asking a separate resolver for a decision. Unresolved edges never reach Scribe. */
export async function runBoundaryAsrBatch(prisma: PrismaClient, storage: StorageProvider, input: {
  owner: { workspaceId: string; ownerId: string; sessionId: string };
  sourceVideoId: string; sourceSha256: string; directory: string; audio: SermonAudioInput;
  analysisArtifactId: string; initialCorridor: SermonCorridor; expiresAt: Date | null; availableImages: EscalationImage[];
  request: BoundaryAsrBatchRequest; measure: PreparationMeasure;
}) {
  const config = boundaryAsrBatchSettingsSchema.parse({ settings: input.request.settings,
    plan: input.request.plan, maxDocumentBytes: input.request.maxDocumentBytes });
  if (typeof input.request.resolve !== "function") throw new Error("BOUNDARY_ASR_RESOLVER_REQUIRED");
  const result = await input.measure("boundary_asr", () => sampleAmbiguousBoundaries(input.audio, {
    ...config.plan, sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256,
    corridor: input.initialCorridor.sourceInterval,
  }, config.settings, input.directory));
  const { measurements, ...evidence } = result;
  const publish = async (document: object, version: string, boundaryStatus?: "AMBIGUOUS" | "RESOLVED") => {
    const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > config.maxDocumentBytes) throw new Error("BOUNDARY_ASR_DOCUMENT_LIMIT");
    const file = path.join(input.directory, `${version}.json`);
    await writeFile(file, bytes, { flag: "wx" });
    const local = await fileIdentity(file);
    const identity = { sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256,
      kind: "LOCAL_EVIDENCE" as const, sourceInterval: input.audio.sourceInterval, derivationVersion: version,
      configurationSha256: rangeEvidenceSha256(document) };
    const record: ArtifactRecord = { ...identity,
      storageKey: `sources/${input.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.json`,
      sha256: local.sha256, byteCount: BigInt(local.byteCount), retentionClass: "ANALYSIS", expiresAt: input.expiresAt,
      mappingStatus: "DECLARED", mappingEvidenceSha256: null, visualQuality: "NOT_APPLICABLE" };
    return publishMediaArtifact(prisma, storage, input.owner, record, file, "application/json", {
      schemaVersion: version, analysisArtifactId: input.analysisArtifactId, evidenceSha256: identity.configurationSha256,
      ...(boundaryStatus ? { boundaryStatus } : {}),
    });
  };
  const sampling = await publish({ schemaVersion: "registered-boundary-asr-v1", analysisArtifactId: input.analysisArtifactId,
    analysisAudioSha256: input.audio.sha256, evidence }, "registered-boundary-asr-v1");
  const resolution = boundaryAsrResolutionSchema.parse(await input.measure("boundary_resolution", () => input.request.resolve({
    evidence: structuredClone(evidence), artifactId: sampling.artifact.id, artifactSha256: sampling.artifact.sha256,
    initialCorridor: structuredClone(input.initialCorridor),
  })));
  const validateResolution = (resolution: z.infer<typeof boundaryAsrResolutionSchema>) => {
    if (resolution.status !== "RESOLVED") return;
    for (const edge of ["START", "END"] as const) {
      const key = edge === "START" ? "startMs" : "endMs";
      const boundary = resolution.corridor.sourceInterval[key];
      const window = result.plan.windows.find(window => window.edge === edge);
      if (window ? boundary < window.sourceInterval.startMs || boundary > window.sourceInterval.endMs
        : boundary !== input.initialCorridor.sourceInterval[key]) throw new Error("BOUNDARY_ASR_RESOLUTION_OUTSIDE_EVIDENCE");
    }
  };
  validateResolution(resolution);
  const decisionDocument = { schemaVersion: "registered-boundary-resolution-v1", sourceVideoId: input.sourceVideoId,
    sourceSha256: input.sourceSha256, initialCorridor: input.initialCorridor,
    samplingArtifactId: sampling.artifact.id, samplingArtifactSha256: sampling.artifact.sha256,
    samplingEvidenceSha256: result.evidenceSha256, resolution };
  const decision = await publish(decisionDocument, "registered-boundary-resolution-v1", resolution.status);
  if (resolution.status === "AMBIGUOUS" && input.request.prepareVisualEscalation) {
    let finalDecision = decision;
    try {
      // Request preparation cannot send a paid request. Dispatch occurs only through the durable reservation.
      const prepared = await input.request.prepareVisualEscalation({ sourceVideoId: input.sourceVideoId,
        sourceSha256: input.sourceSha256, samplingEvidence: structuredClone(evidence),
        initialCorridor: structuredClone(input.initialCorridor), localDecisionArtifactId: decision.artifact.id,
        localDecisionArtifactSha256: decision.artifact.sha256, availableImages: structuredClone(input.availableImages) });
      if (prepared.request.imageArtifactIds.some(id => !input.availableImages.some(image => image.id === id))) {
        throw new Error("BOUNDARY_VISUAL_IMAGE_NOT_IN_BATCH");
      }
      const escalation = await runVisualBoundaryEscalationOnce(prisma, {
        ...prepared.request, ...input.owner, sourceVideoId: input.sourceVideoId,
        boundaryDecisionArtifactId: decision.artifact.id,
      }, prepared.submit);
      const visualResolution = boundaryAsrResolutionSchema.parse(
        z.object({ response: z.unknown() }).parse(escalation.result).response);
      validateResolution(visualResolution);
      const finalDocument = { schemaVersion: "registered-visual-boundary-resolution-v1", sourceVideoId: input.sourceVideoId,
        sourceSha256: input.sourceSha256, initialCorridor: input.initialCorridor,
        localDecisionArtifactId: decision.artifact.id, localDecisionArtifactSha256: decision.artifact.sha256,
        samplingArtifactId: sampling.artifact.id, escalationId: escalation.escalationId,
        escalationResultSha256: rangeEvidenceSha256(escalation.result), resolution: visualResolution };
      finalDecision = await publish(finalDocument, finalDocument.schemaVersion, visualResolution.status);
      if (visualResolution.status === "AMBIGUOUS") {
        throw new BoundaryAsrUnresolvedError(sampling.artifact.id, finalDecision.artifact.id, escalation.escalationId);
      }
      return { sampling, decision: finalDecision, localDecision: decision, escalation, measurements,
        corridor: { ...visualResolution.corridor, evidenceSha256: rangeEvidenceSha256(finalDocument) } };
    } catch (error) {
      if (error instanceof BoundaryAsrUnresolvedError) throw error;
      const escalation = await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: input.sourceVideoId }, select: { id: true } });
      throw new BoundaryAsrUnresolvedError(sampling.artifact.id, finalDecision.artifact.id, escalation?.id ?? null, { cause: error });
    }
  }
  if (resolution.status === "AMBIGUOUS") throw new BoundaryAsrUnresolvedError(sampling.artifact.id, decision.artifact.id);
  return { sampling, decision, measurements, corridor: { ...resolution.corridor,
    evidenceSha256: rangeEvidenceSha256(decisionDocument) } };
}
