import { ProcessingJobType } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { getStorageProvider } from "@/lib/storage";
import { applyFillerDetection } from "@/lib/transcription/filler-detection";
import { getTranscriptionProvider } from "@/lib/transcription";
import { parseSrt, SrtParseError } from "@/lib/transcription/srt";
import { TranscriptionProviderUnavailableError, type TranscriptionResult } from "@/lib/transcription/types";

/**
 * Transcribes the extracted audio (or parses a user-supplied SRT override, skipping ASR
 * entirely per guide §9 step 5), then persists the transcript + segments. Idempotent: re-running
 * replaces any existing transcript for this source video rather than duplicating it.
 */
export const runTranscribeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: true },
  });

  const sourceVideo = project.sourceVideo;
  if (!sourceVideo) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
  }

  const storage = getStorageProvider();
  let result: TranscriptionResult;
  let providerName: string;

  if (sourceVideo.srtOverrideKey) {
    const srtText = (await storage.readAsBuffer(sourceVideo.srtOverrideKey)).toString("utf-8");
    try {
      result = parseSrt(srtText, sourceVideo.language ?? "en");
    } catch (error) {
      if (error instanceof SrtParseError) {
        throw new JobFailureError("INVALID_FILE_TYPE", "That SRT file couldn't be read.", {
          cause: error,
        });
      }
      throw error;
    }
    providerName = "srt_upload";
  } else {
    if (!sourceVideo.audioKey) {
      throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
    }
    const provider = await getTranscriptionProvider();
    try {
      result = await provider.transcribe({
        audioPath: storage.absolutePath(sourceVideo.audioKey),
        language: sourceVideo.language ?? undefined,
      });
    } catch (error) {
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
    }
    providerName = provider.name;
  }

  const segments = applyFillerDetection(result.segments);
  const fullText = segments.map((segment) => segment.text).join(" ");

  await prisma.$transaction(async (tx) => {
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
          words: segment.words,
        },
      });
    }
  });

  // Keyed by this TRANSCRIBE job's own id (not just the project) so a re-run — e.g. after an
  // SRT override upload — always enqueues a fresh ANALYZE pass instead of reusing an already-
  // succeeded one.
  await enqueueJob(prisma, {
    projectId: project.id,
    type: ProcessingJobType.ANALYZE,
    idempotencyKey: `analyze:${project.id}:${job.id}`,
  });
};
