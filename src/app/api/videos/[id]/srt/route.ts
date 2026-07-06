import { randomUUID } from "node:crypto";
import { ProcessingJobType } from "@prisma/client";
import { after } from "next/server";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { enqueueJob } from "@/lib/jobs/queue";
import { runOnePendingJob } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";
import { SrtParseError, parseSrt } from "@/lib/transcription/srt";

const MAX_SRT_BYTES = 2 * 1024 * 1024;

/** Uploading an SRT skips ASR entirely for this video (guide §9 step 5) and re-runs TRANSCRIBE. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const sourceVideo = await prisma.sourceVideo.findUnique({ where: { id } });
  if (!sourceVideo) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(sourceVideo.workspaceId, workspace.id, "source video");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  if (!request.body) {
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_SRT_BYTES) {
    return apiError("FILE_TOO_LARGE", "SRT files are limited to 2 MB.", { status: 413 });
  }

  try {
    parseSrt(text);
  } catch (error) {
    if (error instanceof SrtParseError) {
      return apiError("INVALID_FILE_TYPE", "That SRT file couldn't be read.");
    }
    throw error;
  }

  const storage = getStorageProvider();
  const srtKey = `srt/${workspace.id}/${sourceVideo.id}.srt`;
  await storage.writeFromWebStream(srtKey, new Blob([text]).stream(), MAX_SRT_BYTES);

  await prisma.sourceVideo.update({
    where: { id: sourceVideo.id },
    data: { srtOverrideKey: srtKey },
  });

  const project = await prisma.project.findFirst({ where: { sourceVideoId: sourceVideo.id } });
  if (project) {
    await prisma.processingJob.deleteMany({
      where: { projectId: project.id, type: ProcessingJobType.TRANSCRIBE },
    });
    await enqueueJob(prisma, {
      projectId: project.id,
      type: ProcessingJobType.TRANSCRIBE,
      idempotencyKey: `transcribe:${project.id}:srt:${randomUUID()}`,
    });

    after(async () => {
      for (let i = 0; i < 3; i += 1) {
        const processed = await runOnePendingJob();
        if (!processed) break;
      }
    });
  }

  return apiData({ sourceVideoId: sourceVideo.id, srtKey });
}
