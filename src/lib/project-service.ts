import {
  Prisma,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  type PrismaClient,
} from "@prisma/client";

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

export function buildDefaultProcessingConfig() {
  return {
    language: "en",
    lengthBucket: "60-89s",
    timeframe: null,
    genre: "sermon",
    mode: "clip",
  };
}

export function buildDraftProjectRecord(
  workspaceId: string,
  input: DraftProjectInput,
  sourceVideoId?: string,
): Prisma.ProjectUncheckedCreateInput {
  return {
    workspaceId,
    sourceVideoId,
    name: normalizeProjectName(input.name),
    status: ProjectStatus.DRAFT,
    series: input.series?.trim() || null,
    speaker: input.speaker?.trim() || null,
    processingConfig: buildDefaultProcessingConfig(),
  };
}

/**
 * URL-based import (paste a YouTube/link). The yt-dlp fetch adapter isn't wired up yet (see
 * DECISIONS.md), so this still only records the intent: a source_videos row with the pasted URL
 * and a WAITING job that's honest in the UI about not running yet. Real upload goes through
 * createProjectFromUploadedSourceVideo instead, which enqueues a real FINALIZE job.
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
      data: buildDraftProjectRecord(workspaceId, input, sourceVideo?.id),
    });

    if (sourceVideo) {
      await tx.processingJob.create({
        data: {
          projectId: project.id,
          type: ProcessingJobType.FINALIZE,
          state: ProcessingJobState.WAITING,
          idempotencyKey: `url-import-unavailable:${project.id}`,
          errorCode: "URL_IMPORT_UNAVAILABLE",
          errorMessageUser: "Importing from a link isn't available yet — upload the file directly.",
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

    const project = await tx.project.create({
      data: {
        ...buildDraftProjectRecord(workspaceId, input, sourceVideo.id),
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
