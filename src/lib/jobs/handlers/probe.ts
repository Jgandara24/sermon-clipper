import { ProcessingJobType } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { extractAudio, extractThumbnail } from "@/lib/media/probe";
import { getStorageProvider } from "@/lib/storage";

/** Extracts a poster thumbnail and a 16kHz mono audio track for later transcription. */
export const runProbeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: true },
  });

  const sourceVideo = project.sourceVideo;
  if (!sourceVideo?.storageKey || sourceVideo.durationS === null) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.");
  }

  const storage = getStorageProvider();
  const filePath = storage.absolutePath(sourceVideo.storageKey);
  const thumbnailKey = `thumbs/${project.workspaceId}/${sourceVideo.id}.jpg`;
  const audioKey = `audio/${project.workspaceId}/${sourceVideo.id}.wav`;
  const thumbnailAtS = Math.min(2, sourceVideo.durationS.toNumber() / 2);

  try {
    await extractThumbnail(filePath, storage.absolutePath(thumbnailKey), thumbnailAtS);
    await extractAudio(filePath, storage.absolutePath(audioKey));
  } catch (error) {
    throw new JobFailureError("STORAGE_UNAVAILABLE", "We couldn't process that video file.", {
      cause: error,
    });
  }

  await prisma.sourceVideo.update({
    where: { id: sourceVideo.id },
    data: { thumbnailKey, audioKey },
  });

  await enqueueJob(prisma, {
    projectId: project.id,
    type: ProcessingJobType.TRANSCRIBE,
    idempotencyKey: `transcribe:${project.id}`,
  });
};
