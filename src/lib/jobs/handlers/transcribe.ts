import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessingJobState, ProcessingJobType } from "@prisma/client";
import { assertSourceReanalysisAllowed } from "@/lib/analysis/reanalysis-policy";
import { transcriptChangedError } from "@/lib/analysis/source-write-boundary";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import {
  finishRuntimeMeasurement,
  startRuntimeMeasurement,
  type RuntimeMeasurement,
} from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import {
  getStorageProvider,
  storageProviderKind,
  storageTransferCostFact,
} from "@/lib/storage";
import { extractAudioRange } from "@/lib/media/probe";
import { applyFillerDetection } from "@/lib/transcription/filler-detection";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import {
  readScribeKeyterms,
  resolveTranscriptionProviders,
  scribePricePerMinuteUsd,
} from "@/lib/transcription";
import { openTranscriptionFallbackHold } from "@/lib/transcription/fallback-hold";
import {
  offsetTranscriptionResult,
  resolveSubmittedSermonRange,
} from "@/lib/transcription/submitted-range";
import { parseSrt, SrtParseError } from "@/lib/transcription/srt";
import {
  TranscriptionProviderUnavailableError,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "@/lib/transcription/types";

async function recordTranscriptionFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  provider: string;
  durationS: number;
  runtime: RuntimeMeasurement;
  outcome: ProcessingCostOutcome;
  source: "audio" | "srt_override";
  keytermsCount?: number;
  /** The window actually sent to the provider — what the invoice is for. */
  submittedScope?: "full_service" | "sermon_range";
}) {
  const isScribe = params.provider === "elevenlabs_scribe_v2";
  await recordProcessingCostFactSafely(params.prisma, {
    stage: "transcription",
    quantity: params.durationS / 60,
    unit: "minute",
    unitCostUsd: isScribe ? scribePricePerMinuteUsd((params.keytermsCount ?? 0) > 0) : 0,
    provider: params.provider,
    model: isScribe ? "scribe_v2" : params.provider,
    providerProvenance: "runtime_provider_selection",
    cpuTimeMs: params.runtime.cpuTimeMs,
    wallTimeMs: params.runtime.wallTimeMs,
    cacheState: "miss",
    attempt: Math.max(1, params.attempt),
    outcome: params.outcome,
    details: {
      source: params.source,
      keytermsCount: params.keytermsCount ?? 0,
      // Paid transcription is priced per audio hour, so the submitted duration IS the invoice
      // line. Recording it separately from the source duration is what makes the missing
      // sermon-boundary stage measurable rather than an assumption.
      submittedDurationS: Math.round(params.durationS),
      submittedScope: params.submittedScope ?? "full_service",
    },
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

async function recordStorageDownloadFact(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  bytes: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  await recordProcessingCostFactSafely(params.prisma, {
    ...storageTransferCostFact({
      direction: "download",
      bytes: params.bytes,
      provider: storageProviderKind(),
      configuredPricePerGbUsd: env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD ?? null,
      wallTimeMs: params.wallTimeMs,
      attempt: Math.max(1, params.attempt),
      outcome: params.outcome,
    }),
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

/**
 * Transcribes the extracted audio (or parses a user-supplied SRT override, skipping ASR
 * entirely per guide §9 step 5), then persists the transcript, segments, and analysis follow-up
 * together. A retry replaces the source transcript and queues analysis of the new words.
 * Provider work can repeat; each attempt keeps its actual cost facts.
 */
export const runTranscribeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: { include: { transcript: { select: { id: true, updatedAt: true } } } } },
  });

  const sourceVideo = project.sourceVideo;
  if (!sourceVideo) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
  }

  // P1.7. A new transcript repoints every positional word id and triggers a clip rebuild, so a
  // re-run is refused before anything is downloaded or paid for once a person has done durable
  // work on any project sharing these words. A first transcription has no clips and passes. Asked again
  // inside the transaction that replaces the transcript, which is the answer that binds.
  await assertSourceReanalysisAllowed(prisma, { sourceVideoId: sourceVideo.id });

  const storage = getStorageProvider();
  const transcriptionKeyterms = readScribeKeyterms(project.processingConfig);
  let result: TranscriptionResult;
  let providerName: string;

  if (sourceVideo.srtOverrideKey) {
    const downloadStartedAt = Date.now();
    let srtBuffer: Buffer;
    try {
      srtBuffer = await storage.readAsBuffer(sourceVideo.srtOverrideKey);
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: srtBuffer.byteLength,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "succeeded",
      });
    } catch (error) {
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: 0,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    const srtText = srtBuffer.toString("utf-8");
    const transcriptionStartedAt = startRuntimeMeasurement();
    try {
      result = parseSrt(srtText, sourceVideo.language ?? "en");
    } catch (error) {
      await recordTranscriptionFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        provider: "srt_upload",
        durationS: sourceVideo.durationS?.toNumber() ?? 0,
        runtime: finishRuntimeMeasurement(transcriptionStartedAt),
        outcome: "failed",
        source: "srt_override",
      });
      if (error instanceof SrtParseError) {
        throw new JobFailureError("INVALID_FILE_TYPE", "That SRT file couldn't be read.", {
          cause: error,
        });
      }
      throw error;
    }
    providerName = "srt_upload";
    await recordTranscriptionFact({
      prisma,
      workspaceId: project.workspaceId,
      projectId: project.id,
      jobId: job.id,
      attempt: job.attempt,
      provider: providerName,
      durationS:
        sourceVideo.durationS?.toNumber() ??
        Math.max(0, ...result.segments.map((segment) => segment.endMs / 1_000)),
      runtime: finishRuntimeMeasurement(transcriptionStartedAt),
      outcome: "succeeded",
      source: "srt_override",
    });
  } else {
    if (!sourceVideo.audioKey) {
      throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
    }
    const { policy, primary, fallback } = resolveTranscriptionProviders();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-transcribe-"));
    const audioPath = path.join(workDir, "audio.wav");
    const audioBytes = await storage.size(sourceVideo.audioKey).catch(() => 0);
    const downloadStartedAt = Date.now();
    let downloadSucceeded = false;
    let providerUsed: TranscriptionProvider | null = null;
    try {
      await storage.downloadToFile(sourceVideo.audioKey, audioPath);
      downloadSucceeded = true;
      await recordStorageDownloadFact({
        prisma,
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        attempt: job.attempt,
        bytes: audioBytes,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "succeeded",
      });
      // Send the narrowest sermon window already known. Until the coarse sermon-boundary stage
      // exists that is normally the complete service, which is temporarily allowed — but the
      // submitted duration is recorded either way, so the cost of the missing stage is a
      // measured number rather than an assumption.
      const sourceDurationMs = (sourceVideo.durationS?.toNumber() ?? 0) * 1_000;
      const submitted = resolveSubmittedSermonRange(project.processingConfig, sourceDurationMs);
      const submittedDurationS = (submitted.endMs - submitted.startMs) / 1_000;
      let submittedAudioPath = audioPath;
      if (submitted.scope === "sermon_range") {
        submittedAudioPath = path.join(workDir, "sermon.wav");
        await extractAudioRange(audioPath, submittedAudioPath, submitted.startMs, submitted.endMs);
      }
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "transcription",
        eventType: "transcription_audio_submitted",
        severity: "info",
        message:
          submitted.scope === "sermon_range"
            ? "Transcription received the known sermon range."
            : "Transcription received the complete service because no sermon range is known yet.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          scope: submitted.scope,
          submittedDurationS: Math.round(submittedDurationS),
          sourceDurationS: Math.round(sourceDurationMs / 1_000),
        },
      });

      // Every attempt records its own cost fact, successful or not, so a provider that failed
      // after doing paid work still appears in the cost truth.
      const transcribeWith = async (candidate: TranscriptionProvider) => {
        const startedAt = startRuntimeMeasurement();
        try {
          const transcription = await candidate.transcribe({
            audioPath: submittedAudioPath,
            language: sourceVideo.language ?? undefined,
            keyterms: transcriptionKeyterms,
          });
          await recordTranscriptionFact({
            prisma,
            workspaceId: project.workspaceId,
            projectId: project.id,
            jobId: job.id,
            attempt: job.attempt,
            provider: candidate.name,
            // The submitted window, not the source duration: this is the quantity the provider
            // priced. They differ the moment a sermon range is known.
            durationS:
              submittedDurationS ||
              Math.max(0, ...transcription.segments.map((segment) => segment.endMs / 1_000)),
            runtime: candidate.lastTelemetry ?? finishRuntimeMeasurement(startedAt),
            outcome: "succeeded",
            source: "audio",
            keytermsCount: transcriptionKeyterms.length,
            submittedScope: submitted.scope,
          });
          // Stored timestamps always live on the source timeline.
          return offsetTranscriptionResult(transcription, submitted.startMs);
        } catch (error) {
          await recordTranscriptionFact({
            prisma,
            workspaceId: project.workspaceId,
            projectId: project.id,
            jobId: job.id,
            attempt: job.attempt,
            provider: candidate.name,
            durationS: submittedDurationS,
            runtime: candidate.lastTelemetry ?? finishRuntimeMeasurement(startedAt),
            outcome: "failed",
            source: "audio",
            keytermsCount: transcriptionKeyterms.length,
            submittedScope: submitted.scope,
          });
          throw error;
        }
      };

      // The fallback exists for a primary that cannot serve — no credentials, or an outage
      // mid-job. It is a visible, recorded downgrade, never a silent one: the church's clips
      // would otherwise be captioned by a different provider with nothing to show for it.
      const fallBackTo = async (reason: "unavailable" | "failed") => {
        if (!fallback || !policy.fallback || !(await fallback.isAvailable())) return null;
        await recordOperationalEventSafely(prisma, {
          workspaceId: project.workspaceId,
          category: "transcription",
          eventType: "transcription_provider_fallback",
          severity: "warning",
          message: `Transcription used the fallback provider because the primary was ${reason}. Check the clips before publishing them.`,
          projectId: project.id,
          jobId: job.id,
          // Provider names only. No error text: this event is visible to the church.
          metadata: { primary: policy.primary, fallback: policy.fallback, reason },
        });
        // The warning tells a person. The hold is what actually stops delivery — a warning
        // nobody happens to read must not be the only thing between a degraded transcript and
        // a published clip.
        await openTranscriptionFallbackHold(prisma, {
          workspaceId: project.workspaceId,
          projectId: project.id,
          jobId: job.id,
          primaryProvider: policy.primary,
          usedProvider: policy.fallback,
          reason,
        });
        return fallback;
      };

      let provider = primary;
      if (!(await primary.isAvailable())) {
        const substitute = await fallBackTo("unavailable");
        if (!substitute) {
          throw new TranscriptionProviderUnavailableError(
            `Primary transcription provider ${policy.primary} is not configured and no usable fallback is set.`,
          );
        }
        provider = substitute;
      }

      try {
        result = await transcribeWith(provider);
      } catch (error) {
        const substitute = provider === primary ? await fallBackTo("failed") : null;
        if (!substitute) throw error;
        provider = substitute;
        result = await transcribeWith(provider);
      }
      // A hold is NOT settled here. A successful primary transcription is only the first of the
      // three conditions; the clips have not been rebuilt yet, and the work a person did on the
      // fallback clips is still standing. ANALYZE settles it inside the rebuild transaction.
      providerUsed = provider;
    } catch (error) {
      if (!downloadSucceeded) {
        await recordStorageDownloadFact({
          prisma,
          workspaceId: project.workspaceId,
          projectId: project.id,
          jobId: job.id,
          attempt: job.attempt,
          bytes: audioBytes,
          wallTimeMs: Date.now() - downloadStartedAt,
          outcome: "failed",
        });
      }
      if (error instanceof TranscriptionProviderUnavailableError) {
        throw new JobFailureError(
          "TRANSCRIBE_PROVIDER_UNAVAILABLE",
          "Transcription isn't configured on this environment yet.",
          { cause: error },
        );
      }
      throw new JobFailureError("TRANSCRIBE_FAILED", "We couldn't transcribe the audio.", {
        cause: error,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    providerName = providerUsed?.name ?? policy.primary;
  }

  const segments = applyFillerDetection(result.segments);
  const fullText = segments.map((segment) => segment.text).join(" ");

  await prisma.$transaction(async (tx) => {
    // Match ANALYZE/SRT/retention lock order. NO KEY UPDATE still permits a source-locked
    // durable writer to finish its project foreign-key check while we wait for the source.
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id}::uuid FOR NO KEY UPDATE`;
    const currentProject = await tx.project.findUnique({
      where: { id: project.id }, select: { sourceVideoId: true, workspaceId: true },
    });
    if (currentProject?.sourceVideoId !== sourceVideo.id || currentProject.workspaceId !== project.workspaceId) {
      throw transcriptChangedError();
    }
    // Two projects can transcribe the same source. Serialize their commits and reject a result
    // computed from an input or transcript that changed while storage/provider work was running.
    // Keep this lock short: no storage reads or provider calls occur in this transaction.
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${sourceVideo.id}::uuid FOR UPDATE`;
    const current = await tx.sourceVideo.findUnique({
      where: { id: sourceVideo.id },
      include: { transcript: { select: { id: true, updatedAt: true } } },
    });
    if (!current || current.updatedAt.getTime() !== sourceVideo.updatedAt.getTime() ||
        current.transcriptRevision !== sourceVideo.transcriptRevision ||
        current.transcript?.id !== sourceVideo.transcript?.id ||
        current.transcript?.updatedAt.getTime() !== sourceVideo.transcript?.updatedAt.getTime()) {
      throw transcriptChangedError();
    }
    await assertSourceReanalysisAllowed(tx, { sourceVideoId: sourceVideo.id });
    // Durable writers share the source lock. Advance the token in the same commit as the words
    // so a request for an old clip cannot save after waiting for this replacement to finish.
    await tx.sourceVideo.update({ where: { id: sourceVideo.id }, data: { transcriptRevision: { increment: 1 } } });
    await tx.transcript.deleteMany({ where: { sourceVideoId: sourceVideo.id } });
    const transcript = await tx.transcript.create({
      data: {
        sourceVideoId: sourceVideo.id,
        language: result.language,
        provider: providerName,
        fullText,
      },
    });

    for (const [idx, segment] of segments.entries()) {
      await tx.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          idx,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          speakerLabel: segment.speakerLabel,
          words: segment.words,
        },
      });
    }
    // The transcript UUID is new in this transaction, even on a retry of the same job.
    // Never reuse its earlier completed analysis. If this insert fails, the words and
    // revision roll back too. A committed transcript cannot lose its queue handoff.
    await tx.processingJob.create({ data: {
      projectId: project.id,
      type: ProcessingJobType.ANALYZE,
      state: ProcessingJobState.QUEUED,
      idempotencyKey: `analyze:${project.id}:${job.id}:${transcript.id}`,
    } });
  });

  return {
    metadata: {
      provider: providerName,
      language: result.language,
      segmentCount: segments.length,
      wordCount: segments.reduce((total, segment) => total + segment.words.length, 0),
      source: sourceVideo.srtOverrideKey ? "srt_override" : "audio",
    },
  };
};
