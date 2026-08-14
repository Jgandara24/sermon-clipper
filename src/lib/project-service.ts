import {
  Prisma,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  type PrismaClient,
} from "@prisma/client";
import {
  calendarDateInTimezone,
  deriveServiceSlot,
  isValidIanaTimezone,
  parseChurchProfile,
  targetClipCountFor,
  type ChurchProfile,
  type ServiceSlot,
} from "@/lib/church-profile";
import {
  readCandidateLimit,
  readTargetClipCount,
  resolveCandidateLimit,
} from "@/lib/analysis/candidate-limit";
import { env } from "@/lib/env";
import { readCandidateLimitOverride } from "@/lib/operations/candidate-limit-override";
import { assertWorkspaceAccess } from "@/lib/billing/access";

export const PROCESSING_CONFIGURATION_VERSION = 1;

export type DraftProjectInput = {
  name: string;
  sourceUrl?: string;
  series?: string;
  speaker?: string;
  /** The sermon/video's original publish timestamp, when known (e.g. auto-import from YouTube). */
  publishedAt?: Date;
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

export function buildDefaultProcessingConfig(
  profile: ChurchProfile = parseChurchProfile(null),
  serviceOccurrence: ServiceSlot = "PRIMARY",
  candidateLimitOverride?: unknown,
) {
  const targetClipCount = targetClipCountFor(profile.sermonsPerWeek);
  return {
    language: "en",
    lengthBucket: "60-89s",
    timeframe: null,
    genre: "sermon",
    mode: "clip",
    configurationVersion: PROCESSING_CONFIGURATION_VERSION,
    candidateLimit: resolveCandidateLimit({
      targetClipCount,
      churchOverride: candidateLimitOverride,
      masterDefault: env.CANDIDATE_LIMIT_DEFAULT,
      masterMaximum: env.CANDIDATE_LIMIT_MAXIMUM,
    }),
    targetClipCount,
    timezone: profile.timezone,
    serviceDay: profile.serviceDay,
    secondServiceDay: profile.secondServiceDay,
    sermonsPerWeek: profile.sermonsPerWeek,
    serviceOccurrence,
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Reads a project snapshot defensively so legacy projects use the current code defaults. */
export function readProjectProcessingConfig(processingConfig: unknown) {
  const raw = readObject(processingConfig);
  const defaults = buildDefaultProcessingConfig();
  const targetClipCount = readTargetClipCount(raw);
  const candidateLimit = readCandidateLimit(raw, {
    masterDefault: env.CANDIDATE_LIMIT_DEFAULT,
    masterMaximum: env.CANDIDATE_LIMIT_MAXIMUM,
  });
  const timezone =
    typeof raw.timezone === "string" && isValidIanaTimezone(raw.timezone)
      ? raw.timezone
      : defaults.timezone;

  return {
    language: readNonEmptyString(raw.language, defaults.language),
    lengthBucket: readNonEmptyString(raw.lengthBucket, defaults.lengthBucket),
    timeframe: typeof raw.timeframe === "string" ? raw.timeframe : defaults.timeframe,
    genre: readNonEmptyString(raw.genre, defaults.genre),
    mode: readNonEmptyString(raw.mode, defaults.mode),
    configurationVersion:
      typeof raw.configurationVersion === "number" &&
      Number.isInteger(raw.configurationVersion) &&
      raw.configurationVersion > 0
        ? raw.configurationVersion
        : defaults.configurationVersion,
    candidateLimit,
    targetClipCount,
    timezone,
    serviceDay: readNonEmptyString(raw.serviceDay, defaults.serviceDay),
    secondServiceDay:
      typeof raw.secondServiceDay === "string" ? raw.secondServiceDay : defaults.secondServiceDay,
    sermonsPerWeek: raw.sermonsPerWeek === 2 ? 2 : defaults.sermonsPerWeek,
    serviceOccurrence: raw.serviceOccurrence === "SECONDARY" ? "SECONDARY" : defaults.serviceOccurrence,
  };
}

export function buildDraftProjectRecord(
  workspaceId: string,
  input: DraftProjectInput,
  sourceVideoId?: string,
  profile: ChurchProfile = parseChurchProfile(null),
  serviceContext: { sermonDate: Date; serviceSlot: ServiceSlot } = {
    sermonDate: calendarDateInTimezone(new Date(), "America/Chicago"),
    serviceSlot: "PRIMARY",
  },
  candidateLimitOverride?: unknown,
): Prisma.ProjectUncheckedCreateInput {
  return {
    workspaceId,
    sourceVideoId,
    name: normalizeProjectName(input.name),
    status: ProjectStatus.DRAFT,
    series: input.series?.trim() || null,
    speaker: input.speaker?.trim() || null,
    processingConfig: buildDefaultProcessingConfig(
      profile,
      serviceContext.serviceSlot,
      candidateLimitOverride,
    ),
    sermonDate: serviceContext.sermonDate,
    serviceSlot: serviceContext.serviceSlot,
  };
}

async function getWorkspaceProjectSettings(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
) {
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { settings: true, accessPlan: true, trialStartedAt: true, trialEndsAt: true },
  });
  assertWorkspaceAccess(workspace, "import_media");
  return {
    churchProfile: parseChurchProfile(workspace.settings),
    candidateLimitOverride: readCandidateLimitOverride(workspace.settings),
  };
}

/**
 * Classifies which weekly service a sermon belongs to (Sunday vs. Wednesday, etc.) from its
 * publish timestamp — or "now" for a direct upload with no known publish date — and normalizes
 * it to a timezone-correct calendar date for the Project.sermonDate column.
 */
function buildServiceContext(profile: ChurchProfile, publishedAt?: Date) {
  const instant = publishedAt ?? new Date();
  return {
    sermonDate: calendarDateInTimezone(instant, profile.timezone),
    serviceSlot: deriveServiceSlot(instant, profile),
  };
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

    const { churchProfile, candidateLimitOverride } = await getWorkspaceProjectSettings(tx, workspaceId);
    const serviceContext = buildServiceContext(churchProfile, input.publishedAt);

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
        ...buildDraftProjectRecord(
          workspaceId,
          input,
          sourceVideo?.id,
          churchProfile,
          serviceContext,
          candidateLimitOverride,
        ),
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

    const { churchProfile, candidateLimitOverride } = await getWorkspaceProjectSettings(tx, workspaceId);
    const serviceContext = buildServiceContext(churchProfile);

    const project = await tx.project.create({
      data: {
        ...buildDraftProjectRecord(
          workspaceId,
          input,
          sourceVideo.id,
          churchProfile,
          serviceContext,
          candidateLimitOverride,
        ),
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
