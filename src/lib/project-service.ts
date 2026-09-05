import {
  Prisma,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  type PrismaClient,
} from "@prisma/client";
import { assessReanalysis } from "@/lib/analysis/reanalysis-policy";
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

/**
 * Reads the occurrence a project was created with. This must recognise every ServiceSlot value:
 * it previously collapsed anything that was not the exact string "SECONDARY" back to PRIMARY,
 * which would silently undo P1.8's UNMATCHED derivation for every reader of the snapshot — and
 * P1.9 reads occurrence from the snapshot, not the live profile. An unrecognised value still
 * falls back, so legacy rows keep working.
 */
function readServiceOccurrence(value: unknown, fallback: ServiceSlot): ServiceSlot {
  return value === "SECONDARY" || value === "UNMATCHED" || value === "PRIMARY" ? value : fallback;
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
    serviceOccurrence: readServiceOccurrence(raw.serviceOccurrence, defaults.serviceOccurrence),
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
    select: {
      settings: true,
      accessPlan: true,
      trialStartedAt: true,
      trialEndsAt: true,
      paidAt: true,
    },
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
 * The service context for a project whose uploader told us the date, and possibly the occurrence.
 *
 * What a person states wins over what the code can infer. Falling back to ingestion time is the
 * behaviour P1.10 removes: a Tuesday upload of Sunday's sermon was filed as a Tuesday service,
 * which after P1.8 makes it UNMATCHED and therefore unschedulable. When the occurrence is not
 * stated, it is derived from the stated date, which is the right inference to keep.
 */
export function buildStatedServiceContext(
  profile: ChurchProfile,
  stated: { sermonDate?: Date; serviceOccurrence?: ServiceSlot },
): { sermonDate: Date; serviceSlot: ServiceSlot } {
  if (!stated.sermonDate) return buildServiceContext(profile);

  // The date arrives as a calendar date the uploader picked in their own locale; it is stored as
  // that same calendar date, not re-read through the church timezone, which would shift it.
  const sermonDate = new Date(
    Date.UTC(
      stated.sermonDate.getUTCFullYear(),
      stated.sermonDate.getUTCMonth(),
      stated.sermonDate.getUTCDate(),
    ),
  );
  return {
    sermonDate,
    serviceSlot:
      stated.serviceOccurrence ??
      // The weekday is read in UTC because `sermonDate` is already a calendar date pinned to UTC
      // midnight. Reading it in the church's zone would apply that offset a second time and
      // report the previous day — the same reason the P1.8 allocator reads its cursor in UTC.
      deriveServiceSlot(sermonDate, { ...profile, timezone: "UTC" }),
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
  /**
   * The service this file is from. A direct upload has no publish timestamp to infer from, and
   * inferring from ingestion time is what filed a Tuesday upload of Sunday's sermon as Tuesday's
   * service. Asked for at upload instead; absent only for callers that genuinely know neither.
   */
  sermonDate?: Date;
  /** Which weekly service this is. Absent means "derive it from the date and the profile". */
  serviceOccurrence?: ServiceSlot;
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
    const serviceContext = buildStatedServiceContext(churchProfile, input);

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

/** Why a service-context correction was refused, or `null` when it was applied. */
export type ServiceContextCorrectionRefusal = "not_found" | "durable_work";

/**
 * Corrects a project's sermon date and service occurrence.
 *
 * The correction window closes at the same boundary re-analysis does. Both change which calendar
 * dates the sermon owns, and once a slot has published, is in flight, or an operator has blocked
 * one, moving the sermon would leave that record describing a service the project no longer says
 * it is. Refusing is the same rule P1.7 applies to rebuilding clips, read from the same module so
 * the two can never drift apart.
 *
 * This is also the remedy for projects created before P1.8, whose occurrence was recorded as
 * PRIMARY whatever weekday they fell on.
 */
export async function correctProjectServiceContext(
  client: PrismaClient,
  params: {
    projectId: string;
    workspaceId: string;
    sermonDate: Date;
    serviceOccurrence: ServiceSlot;
  },
): Promise<{ ok: true } | { ok: false; reason: ServiceContextCorrectionRefusal }> {
  return client.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: params.projectId },
      select: { id: true, workspaceId: true, processingConfig: true },
    });
    // A project in another workspace is reported as missing, not as forbidden: the caller has no
    // business learning that this id exists.
    if (!project || project.workspaceId !== params.workspaceId) {
      return { ok: false as const, reason: "not_found" as const };
    }

    const assessment = await assessReanalysis(tx, { projectId: params.projectId });
    if (!assessment.allowed) {
      return { ok: false as const, reason: "durable_work" as const };
    }

    const sermonDate = new Date(
      Date.UTC(
        params.sermonDate.getUTCFullYear(),
        params.sermonDate.getUTCMonth(),
        params.sermonDate.getUTCDate(),
      ),
    );

    // The snapshot is corrected alongside the columns. Scheduling reads occurrence from the
    // snapshot (P1.9), so correcting only Project.serviceSlot would leave the allocator reading
    // the old value and the correction would appear to do nothing.
    const snapshot = readObject(project.processingConfig);
    await tx.project.update({
      where: { id: params.projectId },
      data: {
        sermonDate,
        serviceSlot: params.serviceOccurrence,
        processingConfig: {
          ...snapshot,
          serviceOccurrence: params.serviceOccurrence,
        } as Prisma.InputJsonValue,
      },
    });

    return { ok: true as const };
  });
}
