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
    phase: "phase-1-stub",
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

    await tx.processingJob.create({
      data: {
        projectId: project.id,
        type: ProcessingJobType.PROBE,
        state: ProcessingJobState.WAITING,
        idempotencyKey: `phase1:${project.id}:probe-stub`,
        errorMessageUser: "Video processing is intentionally stubbed in Phase 1.",
        minutesReserved: new Prisma.Decimal("0.00"),
      },
    });

    return project;
  });
}
