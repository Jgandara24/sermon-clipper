import { boundaryAsrBatchSettingsSchema, runBoundaryAsrBatch, type BoundaryAsrBatchRequest } from "./boundary-asr-batch";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileIdentity } from "@/lib/storage/file-identity";
import { runSparseOcr, sparseOcrInputSchema, sparseOcrSettingsSchema } from "./sparse-ocr";
import { proxyViewPlanRequestSchema, sampleProxyViewFrames, type ProxyViewPlanRequest } from "./proxy-view-sampling";
import { buildProxyView } from "./proxy-views";
import { unmeasuredPreparation, type PreparationMeasure } from "./preparation-measurement";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { artifactIdentityKey, type ArtifactRecord } from "@/lib/media-artifacts/types";
import { publishMediaArtifact } from "@/lib/media-artifacts/publication";
import type { StorageProvider } from "@/lib/storage/types";
import { analysisDerivativeSettingsSchema, buildAnalysisDerivatives, type AnalysisDerivativeSettings } from "./analysis-derivatives";
import { buildLocalEvidenceDocument, localEvidenceSettingsSchema, type LocalEvidenceSettings } from "./local-evidence";
import { extractRepresentativeFrames } from "./representative-frames";
import { extractSermonAudio, sermonAudioSettingsSchema, sermonCorridorSchema } from "./sermon-audio";
import { rangeEvidenceSha256 } from "./range-evidence";
import { withMaterializedSource, type MaterializedSource, type SourceLeaseRequest } from "./source-lease";

const retentionSchema = z.object({ analysisExpiresAt: z.date().nullable(), previewExpiresAt: z.date().nullable() }).strict();
const sermonRequestSchema = z.object({ corridor: sermonCorridorSchema, settings: sermonAudioSettingsSchema }).strict();
export type AnalysisBatchSermonRequest = z.infer<typeof sermonRequestSchema>;
export type AnalysisBatchRetention = z.infer<typeof retentionSchema>;
export type AnalysisBatchSermonContext = {
  source: MaterializedSource;
  analysis: Awaited<ReturnType<typeof buildAnalysisDerivatives>>["analysis"];
  audio: Awaited<ReturnType<typeof extractSermonAudio>>;
  artifact: Awaited<ReturnType<typeof publishMediaArtifact>>["artifact"];
};

export type AnalysisBatchOcrRequest = {
  settings: z.infer<typeof sparseOcrSettingsSchema>;
  maxDocumentBytes: number;
  select: (context: {
    sourceVideoId: string; sourceSha256: string; localEvidencePath: string; localEvidenceSha256: string;
    frames: z.infer<typeof sparseOcrInputSchema>["frames"];
  }) => Promise<z.infer<typeof sparseOcrInputSchema>["selections"]>;
};

/** Builds and publishes both analysis outputs within one source lease.
 * Callers must choose measured settings and retention dates. This is not a PROBE default.
 * A failed batch retains its registered artifacts and unfinished session for recovery.
 * The optional awaited sermon consumer must return persistent data without local paths.
 */
export async function runAnalysisDerivativeBatch<T = undefined>(prisma: PrismaClient, storage: StorageProvider,
  request: SourceLeaseRequest, settingsInput: AnalysisDerivativeSettings, retentionInput: AnalysisBatchRetention, evidenceInput?: LocalEvidenceSettings,
  sermonInput?: AnalysisBatchSermonRequest, consumeSermon?: (context: AnalysisBatchSermonContext) => Promise<T>,
  measure: PreparationMeasure = unmeasuredPreparation, viewsInput: ProxyViewPlanRequest[] = [], ocrInput?: AnalysisBatchOcrRequest, boundaryInput?: BoundaryAsrBatchRequest) {
  const views = z.array(proxyViewPlanRequestSchema).max(8).parse(viewsInput);
  if (views.some(view => "sampling" in view) && !evidenceInput) throw new Error("PROXY_VIEW_LOCAL_EVIDENCE_REQUIRED");
  const settings = analysisDerivativeSettingsSchema.parse(settingsInput);
  const retention = retentionSchema.parse(retentionInput);
  let sermonRequest = sermonInput === undefined ? undefined : sermonRequestSchema.parse(sermonInput);
  if (consumeSermon && !sermonRequest) throw new Error("MEDIA_SERMON_CORRIDOR_REQUIRED");
  const evidenceSettings = evidenceInput === undefined ? undefined : localEvidenceSettingsSchema.parse(evidenceInput);
  const ocrSettings = ocrInput ? sparseOcrSettingsSchema.parse(ocrInput.settings) : undefined;
  const ocrDocumentLimit = ocrInput ? z.number().int().positive().max(2147483647).parse(ocrInput.maxDocumentBytes) : 0;
  if (ocrInput && (!evidenceSettings?.representatives || typeof ocrInput.select !== "function")) {
    throw new Error("OCR_REPRESENTATIVE_SETTINGS_REQUIRED");
  }
  if (boundaryInput) {
    boundaryAsrBatchSettingsSchema.parse({ settings: boundaryInput.settings, plan: boundaryInput.plan,
      maxDocumentBytes: boundaryInput.maxDocumentBytes });
    if (!sermonRequest || typeof boundaryInput.resolve !== "function") throw new Error("BOUNDARY_ASR_SERMON_AND_RESOLVER_REQUIRED");
  }
  // Refuse unsupported publication before acquiring and encoding the original.
  if (!storage.uploadFileIfAbsent || !storage.getObjectIdentity || !storage.getStorageIdentity) throw new Error("MEDIA_PUBLICATION_STORAGE_UNSUPPORTED");
  return withMaterializedSource(prisma, storage, request, async source => {
    const built = await measure("analysis_derivatives", () => buildAnalysisDerivatives(source, settings));
    const owner = { workspaceId: request.workspaceId, ownerId: request.ownerId, sessionId: source.sessionId };
    const common = {
      sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
      sourceInterval: built.sourceInterval, derivationVersion: built.derivationVersion,
      configurationSha256: built.configurationSha256, mappingStatus: built.mappingStatus, mappingEvidenceSha256: null,
    };
    const analysisIdentity = { ...common, sourceInterval: built.analysis.sourceInterval, kind: "ANALYSIS_AUDIO" as const };
    const proxyIdentity = { ...common, kind: "SOURCE_PROXY" as const };
    const key = (identity: typeof analysisIdentity | typeof proxyIdentity, extension: string) =>
      `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey({
        sourceVideoId: identity.sourceVideoId, sourceSha256: identity.sourceSha256, kind: identity.kind,
        sourceInterval: identity.sourceInterval, derivationVersion: identity.derivationVersion,
        configurationSha256: identity.configurationSha256,
      })}.${extension}`;
    const analysisRecord: ArtifactRecord = {
      ...analysisIdentity, mappingStatus: "VERIFIED", mappingEvidenceSha256: built.analysis.mappingEvidenceSha256, storageKey: key(analysisIdentity, "flac"), sha256: built.analysis.sha256,
      byteCount: BigInt(built.analysis.byteCount), retentionClass: "ANALYSIS", expiresAt: retention.analysisExpiresAt,
      visualQuality: "NOT_APPLICABLE",
    };
    const proxyRecord: ArtifactRecord = {
      ...proxyIdentity, storageKey: key(proxyIdentity, "mp4"), sha256: built.proxy.sha256,
      byteCount: BigInt(built.proxy.byteCount), retentionClass: "PREVIEW", expiresAt: retention.previewExpiresAt,
      visualQuality: built.visualQuality,
    };
    const evidence = {
      version: "analysis-batch-v1", settings: built.settings, toolchainSha256: built.toolchainSha256,
      original: built.original, sourcePresentationOriginMs: built.sourcePresentationOriginMs,
      sourceInterval: built.sourceInterval, encodingWallMs: built.encodingWallMs,
    };
    // Sequential publication leaves no unawaited storage writer if either operation fails.
    const analysis = await publishMediaArtifact(prisma, storage, owner, analysisRecord, built.analysis.path,
      "audio/flac", { ...evidence, output: built.analysis.facts, mappingEvidence: built.analysis.mappingEvidence });
    const proxy = await publishMediaArtifact(prisma, storage, owner, proxyRecord, built.proxy.path,
      "video/mp4", { ...evidence, output: built.proxy.facts });
    const representatives: Array<Awaited<ReturnType<typeof publishMediaArtifact>> & {
      sourceTimeMs: number; groupIndex: number; sampleIndex: number;
    }> = [];
    let frameSampleTimesMs: number[] = [];
    let localEvidence: Awaited<ReturnType<typeof publishMediaArtifact>> | undefined;
    let ocr: (Awaited<ReturnType<typeof publishMediaArtifact>> & { measurements: Awaited<ReturnType<typeof runSparseOcr>>["measurements"] }) | undefined;
    if (evidenceSettings) {
      const document = await measure("local_evidence", () => buildLocalEvidenceDocument(source, built, evidenceSettings));
      frameSampleTimesMs = document.frameSampleTimesMs;
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
        sourceInterval: built.sourceInterval, kind: "LOCAL_EVIDENCE" as const,
        derivationVersion: document.derivationVersion, configurationSha256: document.configurationSha256 };
      const record: ArtifactRecord = { ...identity,
        storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.json`,
        sha256: document.sha256, byteCount: BigInt(document.byteCount), retentionClass: "ANALYSIS",
        expiresAt: retention.analysisExpiresAt, mappingStatus: "DECLARED", mappingEvidenceSha256: null,
        visualQuality: "NOT_APPLICABLE" };
      localEvidence = await publishMediaArtifact(prisma, storage, owner, record, document.path, "application/json",
        { schemaVersion: document.derivationVersion, counts: document.counts,
          analysisArtifactId: analysis.artifact.id, proxyArtifactId: proxy.artifact.id });
      if (evidenceSettings.representatives) {
        const selected = await measure("representative_frames", () => extractRepresentativeFrames({ path: built.proxy.path, sha256: built.proxy.sha256,
          byteCount: built.proxy.byteCount, mapping: { sourceInterval: built.sourceInterval, artifactOriginMs: 0, timeScale: "1:1" } },
        document.representativeSelection.map(item => item.sourceTimeMs), source.directory, evidenceSettings.representatives!));
        for (const [index, frame] of selected.frames.entries()) {
          // A one-millisecond marker identifies the sampled instant; it does not describe frame duration.
          const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "SPARSE_FRAME" as const,
            sourceInterval: { startMs: frame.sourceTimeMs, endMs: frame.sourceTimeMs + 1 },
            derivationVersion: selected.derivationVersion, configurationSha256: selected.configurationSha256 };
          const record: ArtifactRecord = { ...identity,
            storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.webp`,
            sha256: frame.sha256, byteCount: BigInt(frame.byteCount), retentionClass: "ANALYSIS",
            expiresAt: retention.analysisExpiresAt, mappingStatus: "DECLARED", mappingEvidenceSha256: null,
            visualQuality: "NOT_REVIEWED" };
          const published = await publishMediaArtifact(prisma, storage, owner, record, frame.path, "image/webp", {
            proxyArtifactId: proxy.artifact.id, sampledSourceTimeMs: frame.sourceTimeMs,
            width: frame.width, height: frame.height, bgraSha256: frame.bgraSha256,
            verification: "decoded-bgra-sha256-equal", toolchainSha256: selected.toolchainSha256,
          });
          representatives.push({ ...published, ...document.representativeSelection[index] });
        }
        if (ocrInput && ocrSettings) {
          const frames = selected.frames.map((frame, index) => ({ groupIndex: document.representativeSelection[index].groupIndex,
            sourceTimeMs: frame.sourceTimeMs, path: frame.path, sha256: frame.sha256, byteCount: frame.byteCount,
            width: frame.width, height: frame.height }));
          const result = await measure("sparse_ocr", async () => {
            const selections = await ocrInput.select({ sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
              localEvidencePath: document.path, localEvidenceSha256: document.sha256, frames: frames.map(frame => ({ ...frame })) });
            return runSparseOcr({ sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
              representativeEvidenceSha256: document.sha256, frames, selections }, ocrSettings);
          });
          const { measurements, ...ocrEvidence } = result;
          const frameArtifacts = result.results.map(item => {
            const frame = representatives.find(frame => frame.groupIndex === item.groupIndex)!;
            return { groupIndex: item.groupIndex, artifactId: frame.artifact.id, sha256: frame.artifact.sha256 };
          });
          const ocrDocument = { schemaVersion: "registered-sparse-ocr-v1", localEvidenceArtifactId: localEvidence.artifact.id,
            localEvidenceSha256: document.sha256, frameArtifacts, ocr: ocrEvidence };
          const bytes = Buffer.from(JSON.stringify(ocrDocument));
          if (bytes.length > ocrDocumentLimit) throw new Error("OCR_DOCUMENT_LIMIT_EXCEEDED");
          const file = path.join(source.directory, "sparse-ocr.json");
          await writeFile(file, bytes, { flag: "wx" });
          const local = await fileIdentity(file);
          const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "LOCAL_EVIDENCE" as const,
            sourceInterval: built.sourceInterval, derivationVersion: ocrDocument.schemaVersion,
            configurationSha256: rangeEvidenceSha256({ ocrConfiguration: result.configurationSha256,
              localEvidenceSha256: document.sha256, frames: result.results.map(item => ({ groupIndex: item.groupIndex,
                frameSha256: item.frameSha256, selectionEvidenceSha256: item.selectionEvidenceSha256 })) }) };
          const published = await publishMediaArtifact(prisma, storage, owner, { ...identity,
            storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.json`,
            sha256: local.sha256, byteCount: BigInt(local.byteCount), retentionClass: "ANALYSIS",
            expiresAt: retention.analysisExpiresAt, mappingStatus: "DECLARED", mappingEvidenceSha256: null,
            visualQuality: "NOT_APPLICABLE" }, file, "application/json", {
            schemaVersion: ocrDocument.schemaVersion, localEvidenceArtifactId: localEvidence.artifact.id,
            ocrEvidenceSha256: result.evidenceSha256, frameArtifacts, classification: "not_performed" });
          ocr = { ...published, measurements };
        }
      }
    }
    const publishedViews: Array<Awaited<ReturnType<typeof publishMediaArtifact>>> = [];
    for (const viewPlan of views) {
      if ("sampling" in viewPlan && (viewPlan.sampling.sourceInterval.startMs < built.sourceInterval.startMs ||
        viewPlan.sampling.sourceInterval.endMs > built.sourceInterval.endMs)) throw new Error("PROXY_VIEW_SAMPLING_OUTSIDE_SOURCE");
      const samplingEvidence = "sampling" in viewPlan ? { ...sampleProxyViewFrames(frameSampleTimesMs, viewPlan.sampling),
        localEvidenceArtifactId: localEvidence!.artifact.id, localEvidenceSha256: localEvidence!.artifact.sha256 } : undefined;
      const view = "sampling" in viewPlan ? { kind: viewPlan.kind, columns: viewPlan.columns,
        tileHeight: viewPlan.tileHeight, maxPixels: viewPlan.maxPixels, maxFileBytes: viewPlan.maxFileBytes,
        frames: viewPlan.frames, sourceTimesMs: samplingEvidence!.sourceTimesMs } : viewPlan;
      const builtView = await measure("proxy_view", () => buildProxyView({ path: built.proxy.path,
        sha256: built.proxy.sha256, byteCount: built.proxy.byteCount,
        mapping: { sourceInterval: built.sourceInterval, artifactOriginMs: 0, timeScale: "1:1" } }, view, source.directory));
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: view.kind,
        sourceInterval: builtView.sourceInterval, derivationVersion: builtView.derivationVersion,
        configurationSha256: samplingEvidence ? rangeEvidenceSha256({ imageConfiguration: builtView.configurationSha256, samplingEvidence })
          : builtView.configurationSha256 };
      publishedViews.push(await publishMediaArtifact(prisma, storage, owner, { ...identity,
        storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.webp`,
        sha256: builtView.sha256, byteCount: BigInt(builtView.byteCount), retentionClass: "PREVIEW",
        expiresAt: retention.previewExpiresAt, mappingStatus: "DECLARED", mappingEvidenceSha256: null,
        visualQuality: "NOT_REVIEWED" }, builtView.path, "image/webp", {
        proxyArtifactId: proxy.artifact.id, ...builtView.evidence, ...(samplingEvidence ? { samplingEvidence } : {}),
      }));
    }
    let boundaryAsr: Awaited<ReturnType<typeof runBoundaryAsrBatch>> | undefined;
    if (boundaryInput && sermonRequest) {
      boundaryAsr = await runBoundaryAsrBatch(prisma, storage, { owner, sourceVideoId: source.sourceVideoId,
        sourceSha256: source.sha256, directory: source.directory, audio: {
          path: built.analysis.path, sha256: built.analysis.sha256, byteCount: built.analysis.byteCount,
          sourceInterval: built.analysis.sourceInterval }, analysisArtifactId: analysis.artifact.id,
        initialCorridor: sermonRequest.corridor, expiresAt: retention.analysisExpiresAt, request: boundaryInput, measure,
        availableImages: [...representatives, ...publishedViews].map(({ artifact }) => ({ id: artifact.id, kind: artifact.kind,
          sha256: artifact.sha256, byteCount: artifact.byteCount, startMs: artifact.startMs, endMs: artifact.endMs,
          publicationEvidence: artifact.publicationEvidence })) });
      sermonRequest = { ...sermonRequest, corridor: boundaryAsr.corridor };
    }
    let sermon: Awaited<ReturnType<typeof publishMediaArtifact>> | undefined;
    let consumption: T | undefined;
    if (sermonRequest) {
      const { corridor, settings: sermonSettings } = sermonRequest;
      const selected = await measure("sermon_audio", () => extractSermonAudio({ path: built.analysis.path, sha256: built.analysis.sha256,
        byteCount: built.analysis.byteCount, sourceInterval: built.analysis.sourceInterval },
        corridor, source.directory, sermonSettings));
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
        kind: "SERMON_AUDIO" as const, sourceInterval: sermonRequest.corridor.sourceInterval,
        derivationVersion: selected.evidence.version,
        configurationSha256: rangeEvidenceSha256({ request: sermonRequest, analysisSha256: built.analysis.sha256,
          toolchainSha256: selected.evidence.toolchainSha256 }) };
      const mappingEvidence = { version: "sermon-audio-mapping-v1", analysisArtifactId: analysis.artifact.id,
        analysisMappingEvidenceSha256: built.analysis.mappingEvidenceSha256,
        trimEvidenceSha256: selected.evidenceSha256, sourceInterval: sermonRequest.corridor.sourceInterval, artifactOriginMs: 0 };
      sermon = await publishMediaArtifact(prisma, storage, owner, { ...identity,
        storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.flac`,
        sha256: selected.sha256, byteCount: BigInt(selected.byteCount), retentionClass: "ANALYSIS",
        expiresAt: retention.analysisExpiresAt, mappingStatus: "VERIFIED", mappingEvidenceSha256: rangeEvidenceSha256(mappingEvidence),
        visualQuality: "NOT_APPLICABLE" }, selected.path, "audio/flac", {
        analysisArtifactId: analysis.artifact.id, mappingEvidence, trimEvidence: selected.evidence, trimEvidenceSha256: selected.evidenceSha256,
      });
      if (consumeSermon) consumption = await consumeSermon({ source, analysis: built.analysis, audio: selected, artifact: sermon.artifact });
    }
    // Do not return paths: the lease removes every local file before this result reaches its caller.
    return { sessionId: source.sessionId, sourceVideoId: source.sourceVideoId,
      sourceSha256: source.sha256, sourceByteCount: source.byteCount, sourceDownload: source.download,
      analysis, proxy, views: publishedViews, sermon, consumption, localEvidence, representatives, ocr, boundaryAsr, encodingWallMs: built.encodingWallMs };
  });
}
