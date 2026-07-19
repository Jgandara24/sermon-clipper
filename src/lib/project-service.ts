import {
  Prisma,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  type PrismaClient,
} from "@prisma/client";
import { parseChurchProfile, targetClipCountFor, type SermonsPerWeek } from "@/lib/church-profile";

export type DraftProjectInput = {
  name: string;
  sourceUrl?: string;
  series?: string;
  speaker?: string;
};

export function assertWorkspaceScope(
  entityWorkspaceId: string,
  expectedWorkspaceId: string,
  entityName = "record",
) {
  if (entityWorkspaceId !== expectedWorkspaceId) {
    throw new Error(`Workspace access denied for ${entityName}.`);
  }
}

export function normalizeProjectName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) {
    throw new Error("Project name must be at least 2 characters.");
  }

  if (normalized.length > 120) {
    throw new Error("Project name must be 120 characters or fewer.");
  }

  return normalized;
}

export function buildDefaultProcessingConfig(sermonsPerWeek: SermonsPerWeek = 1) {
  return {
    language: "en",
    lengthBucket: "60-89s",
    timeframe: null,
    genre: "sermon",
    mode: "clip",
    targetClipCount: targetClipCountFor(sermonsPerWeek),
  };
}

export function buildDraftProjectRecord(
  workspaceId: string,
  input: DraftProjectInput,
  sourceVideoId?: string,
  sermonsPerWeek: SermonsPerWeek = 1,
): Prisma.ProjectUncheckedCreateInput {
  return {
    workspaceId,
    sourceVideoId,
    name: normalizeProjectName(input.name),
    status: ProjectStatus.DRAFT,
    series: input.series?.trim() || null,
    speaker: input.speaker?.trim() || null,
    processingConfig: buildDefaultProcessingConfig(sermonsPerWeek),
  };
}

async function getSermonsPerWeek(tx: PrismaClient | Prisma.TransactionClient, workspaceId: string) {
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { settings: true },
  });
  return parseChurchProfile(workspace.settings).sermonsPerWeek;
}

/**
 * URL-based import (paste a YouTube/link). Creates a source_videos row with the pasted URL and
 * enqueues a real FINALIZE job; the worker's FINALIZE URL branch fetches the video via yt-dlp
 * and then follows the same probe/reserve pipeline as an uploaded file. Uploads go through
 * createProjectFromUploadedSourceVideo instead.
 */
export async function createDraftProjectForWorkspace(
  client: PrismaClient,
  workspaceId: string,
  input: DraftProjectInput,
  userId: string,
) {
  return client.$transaction(async (tx) => {
    const membership = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });

    if (!membership) {
      throw new Error("Workspace access denied for project creation.");
    }

    const sermonsPerWeek = await getSermonsPerWeek(tx, workspaceId);

    const sourceUrl = input.sourceUrl?.trim();
    const sourceVideo = sourceUrl
      ? await tx.sourceVideo.create({
          data: {
            workspaceId,
            origin: SourceOrigin.URL,
            originUrl: sourceUrl,
            language: "en",
          },
        })
      : null;

    const project = await tx.project.create({
      data: {
        ...buildDraftProjectRecord(workspaceId, input, sourceVideo?.id, sermonsPerWeek),
        ...(sourceVideo ? { status: ProjectStatus.QUEUED } : {}),
      },
    });

    if (sourceVideo) {
      await tx.processingJob.create({
        data: {
          projectId: project.id,
          type: ProcessingJobType.FINALIZE,
          state: ProcessingJobState.QUEUED,
          idempotencyKey: `finalize:${project.id}`,
        },
      });
    }

    return project;
  });
}

export type UploadedProjectInput = {
  name: string;
  sourceVideoId: string;
  series?: string;
  speaker?: string;
};

/**
 * Creates a project from an already-uploaded source video (see the /api/uploads/* routes) and
 * enqueues the real FINALIZE job, which probes the file and hands off to PROBE on success.
 */
export async function createProjectFromUploadedSourceVideo(
  client: PrismaClient,
  workspaceId: string,
  input: UploadedProjectInput,
  userId: string,
) {
  return client.$transaction(async (tx) => {
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) {
      throw new Error("Workspace access denied for project creation.");
    }

    const sourceVideo = await tx.sourceVideo.findUniqueOrThrow({ where: { id: input.sourceVideoId } });
    assertWorkspaceScope(sourceVideo.workspaceId, workspaceId, "source video");

    const sermonsPerWeek = await getSermonsPerWeek(tx, workspaceId);

    const project = await tx.project.create({
      data: {
        ...buildDraftProjectRecord(workspaceId, input, sourceVideo.id, sermonsPerWeek),
        status: ProjectStatus.QUEUED,
      },
    });

    await tx.processingJob.create({
      data: {
        projectId: project.id,
        type: ProcessingJobType.FINALIZE,
        state: ProcessingJobState.QUEUED,
        idempotencyKey: `finalize:${project.id}`,
      },
    });

    return project;
  });
}
