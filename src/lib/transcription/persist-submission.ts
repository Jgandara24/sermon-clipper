import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertSourceReanalysisAllowed } from "@/lib/analysis/reanalysis-policy";
import { transcriptChangedError } from "@/lib/analysis/source-write-boundary";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { applyFillerDetection } from "./filler-detection";
import { transcriptCapabilitiesSchema, transcriptProvenanceSchema } from "./provenance";
import { buildTranscriptStructure, validateTranscriptStructure } from "./structure";
import { scribeTranscriptCapabilities } from "./scribe-capabilities";

const time = z.number().int().nonnegative().safe();
const wordSchema = z.object({ word: z.string(), startMs: time, endMs: time,
  confidence: z.number().finite().min(0).max(1), isFiller: z.boolean(), deleted: z.literal(false),
  speakerLabel: z.string().optional() }).strict();
const providerEvidenceSchema = z.object({ version: z.literal("scribe-response-evidence-v1"), provider: z.literal("elevenlabs"),
  modelVersion: z.literal("scribe_v2"), timestampClock: z.literal("submitted-audio-seconds"), sourceOffsetMs: time,
  languageProbability: z.number().finite().nullable(), entries: z.array(z.object({ text: z.string(),
    start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(),
    type: z.enum(["word", "spacing", "audio_event"]), speakerId: z.string().nullable(), logProbability: z.number().finite().nullable() }).strict()),
}).strict();
const storedResultSchema = z.object({
  provenance: transcriptProvenanceSchema, capabilities: transcriptCapabilitiesSchema,
  result: z.object({ language: z.string().min(1), providerEvidence: providerEvidenceSchema,
    segments: z.array(z.object({ startMs: time, endMs: time, text: z.string(), speakerLabel: z.string().optional(),
      words: z.array(wordSchema).min(1) }).strict()).min(1) }).strict(),
}).passthrough();
const requestSchema = z.object({ workspaceId: z.string().uuid(), projectId: z.string().uuid(), submissionId: z.string().uuid(), structure: z.unknown().optional() }).strict();

/** Atomically attach a completed durable result and queue analysis. Never calls a provider. */
export async function persistSermonSubmission(prisma: PrismaClient, input: z.infer<typeof requestSchema>) {
  const request = requestSchema.parse(input);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${request.projectId}::uuid FOR NO KEY UPDATE`;
    const project = await tx.project.findUnique({ where: { id: request.projectId } });
    if (!project || project.workspaceId !== request.workspaceId || !project.sourceVideoId) throw new Error("SERMON_PERSIST_PROJECT_NOT_FOUND");
    await lockMediaSource(tx, request.workspaceId, project.sourceVideoId);
    const source = await tx.sourceVideo.findUniqueOrThrow({ where: { id: project.sourceVideoId }, include: { transcript: true } });
    const submission = await tx.sermonTranscriptionSubmission.findUnique({ where: { id: request.submissionId }, include: { artifact: true } });
    if (!submission || submission.sourceVideoId !== source.id || submission.state !== "COMPLETED" || !submission.result ||
      rangeEvidenceSha256(submission.result) !== submission.resultSha256) throw new Error("SERMON_PERSIST_RESULT_INVALID");
    const stored = storedResultSchema.parse(submission.result), provenance = stored.provenance;
    const artifact = submission.artifact;
    if (provenance.sourceVideoId !== source.id || provenance.sourceSha256 !== artifact.sourceSha256 ||
      provenance.submittedAudioSha256 !== artifact.sha256 || BigInt(provenance.sourceInterval.startMs) !== artifact.startMs ||
      BigInt(provenance.sourceInterval.endMs) !== artifact.endMs || stored.result.providerEvidence.sourceOffsetMs !== provenance.sourceOffsetMs ||
      rangeEvidenceSha256(stored.capabilities) !== rangeEvidenceSha256(provenance.capabilities) ||
      rangeEvidenceSha256(scribeTranscriptCapabilities(stored.result.providerEvidence)) !== rangeEvidenceSha256(stored.capabilities)) {
      throw new Error("SERMON_PERSIST_PROVENANCE_MISMATCH");
    }
    for (const segment of stored.result.segments) {
      if (segment.startMs < provenance.sourceInterval.startMs || segment.endMs > provenance.sourceInterval.endMs || segment.endMs < segment.startMs ||
        segment.words.some(word => word.startMs < segment.startMs || word.endMs > segment.endMs || word.endMs < word.startMs)) {
        throw new Error("SERMON_PERSIST_WORD_CLOCK_INVALID");
      }
    }
    const structure = request.structure === undefined ? undefined : validateTranscriptStructure(request.structure, stored.result, provenance);
    const capabilities = structure ? { ...stored.capabilities, ...structure.boundaries.capabilities } : stored.capabilities;
    const finalProvenance = { ...provenance, capabilities };
    const priorEvidence = source.transcript?.providerEvidence;
    const reused = !!source.transcript && priorEvidence !== null && typeof priorEvidence === "object" &&
      !Array.isArray(priorEvidence) && priorEvidence.submissionId === submission.id;
    if (reused && structure && rangeEvidenceSha256(source.transcript!.structure) !== rangeEvidenceSha256(structure)) {
      throw new Error("SERMON_PERSIST_STRUCTURE_CONFLICT");
    }
    let transcript = source.transcript;
    if (!reused) {
      const admission = z.object({ transcriptRevision: time, sourceUpdatedAt: z.string().datetime() }).parse(submission.requestEvidence);
      if (source.transcriptRevision !== admission.transcriptRevision || source.updatedAt.toISOString() !== admission.sourceUpdatedAt) {
        throw transcriptChangedError();
      }
      await assertSourceReanalysisAllowed(tx, { sourceVideoId: source.id });
      const segments = applyFillerDetection(stored.result.segments);
      await tx.sourceVideo.update({ where: { id: source.id }, data: { transcriptRevision: { increment: 1 } } });
      await tx.transcript.deleteMany({ where: { sourceVideoId: source.id } });
      transcript = await tx.transcript.create({ data: { sourceVideoId: source.id, language: stored.result.language,
        provider: "elevenlabs_scribe_v2", fullText: segments.map(segment => segment.text).join(" "),
        capabilities, provenance: finalProvenance, ...(structure ? { structure } : {}), providerEvidence: { ...stored.result.providerEvidence,
          displayCapabilities: stored.capabilities, submissionId: submission.id } } });
      for (const [idx, segment] of segments.entries()) {
        await tx.transcriptSegment.create({ data: { transcriptId: transcript.id, idx,
          startMs: segment.startMs, endMs: segment.endMs, text: segment.text, speakerLabel: segment.speakerLabel, words: segment.words } });
      }
    }
    if (!transcript) throw new Error("SERMON_PERSIST_TRANSCRIPT_MISSING");
    const idempotencyKey = `analyze:${project.id}:sermon:${submission.id}:${transcript.id}`;
    const analysisJob = await tx.processingJob.upsert({ where: { idempotencyKey }, update: {},
      create: { projectId: project.id, type: "ANALYZE", state: "QUEUED", idempotencyKey } });
    return { transcriptId: transcript.id, analysisJobId: analysisJob.id, reused,
      transcriptRevision: reused ? source.transcriptRevision : source.transcriptRevision + 1 };
  });
}


/** Build structure from the durable response, never from a caller's replacement transcript. */
export async function buildSubmissionTranscriptStructure(prisma: PrismaClient,
  input: Omit<Parameters<typeof buildTranscriptStructure>[0], "result" | "provenance"> & { workspaceId: string; submissionId: string }) {
  const submission = await prisma.sermonTranscriptionSubmission.findUnique({ where: { id: input.submissionId }, include: { source: true } });
  if (!submission || submission.source.workspaceId !== input.workspaceId || submission.state !== "COMPLETED" || !submission.result ||
    rangeEvidenceSha256(submission.result) !== submission.resultSha256) throw new Error("SERMON_PERSIST_RESULT_INVALID");
  const stored = storedResultSchema.parse(submission.result);
  return buildTranscriptStructure({ ...input, result: stored.result, provenance: stored.provenance });
}
