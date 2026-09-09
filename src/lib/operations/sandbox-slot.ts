import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { countDurableWork, hasDurableWork } from "@/lib/analysis/reanalysis-policy";
import { calendarDateInTimezone, parseChurchProfile } from "@/lib/church-profile";
import { recordOperationalEvent } from "@/lib/observability/operational-events";
import { assertPlatformOperator } from "@/lib/operator-auth";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";
import { isPromotableReserve, selectReserve } from "@/lib/review/reserve-policy";
import { lockSourceVideoForRetention, sourceExpiresAtForSchedule } from "@/lib/retention";
import { getStorageProvider } from "@/lib/storage";
import { transcriptProviderNameFor } from "@/lib/transcription/fallback-hold";
import { resolveTranscriptionProviderPolicy } from "@/lib/transcription/policy";
import { sandboxSlotInputSchema, type SandboxSlotInput } from "./sandbox-slot-input";

export class SandboxSlotRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SandboxSlotRefusedError";
  }
}

function refuse(code: string, message: string): never {
  throw new SandboxSlotRefusedError(code, message);
}

type Runtime = Record<string, string | undefined>;

function checkRuntime(runtime: Runtime) {
  for (const flag of ["AUTOMATIC_PUBLISHING_ENABLED", "AUTOMATIC_SCHEDULE_ARMING_ENABLED"]) {
    const value = runtime[flag];
    if (value !== undefined && value !== "false") {
      refuse("AUTOMATION_NOT_OFF", `${flag} must be off for sandbox slot preparation.`);
    }
  }
}

export type SandboxSlotPlan = {
  version: 1;
  operatorUserId: string;
  workspace: { id: string; name: string; updatedAt: string };
  project: { id: string; name: string; updatedAt: string };
  source: { id: string; updatedAt: string; transcriptId: string; transcriptUpdatedAt: string; provider: string };
  clip: { id: string; rank: number; title: string; startMs: number; endMs: number; updatedAt: string };
  reserve: { id: string; rank: number; title: string; startMs: number; endMs: number; updatedAt: string };
  date: string;
  platform: "FACEBOOK";
  timezone: string;
  expiresAt: string | null;
};

export type SandboxSlotOutcome = {
  applied: boolean;
  plan: SandboxSlotPlan;
  confirmation: string;
  scheduledPostId: string | null;
};

/**
 * A staff CLI boundary, deliberately absent from the app and the worker.
 *
 * A fresh test service needs one slot while global arming stays off. Read-only by default;
 * apply re-reads all facts and compares them with the reviewed plan. It creates no exports,
 * processing jobs, or editorial decisions. Database credentials are the CLI's authentication;
 * the named operator is checked again here and recorded as the actor, never granted authority.
 * The operator must separately verify the workspace is the intended sandbox. Its name, Page
 * settings, or a CLI flag cannot establish that fact automatically.
 */
export async function prepareSandboxSlot(
  client: PrismaClient,
  rawInput: SandboxSlotInput,
  options: { now?: Date; runtime?: Runtime; sourceExists?: (key: string) => Promise<boolean> } = {},
): Promise<SandboxSlotOutcome> {
  const input = sandboxSlotInputSchema.parse(rawInput);
  const runtime = options.runtime ?? process.env;
  checkRuntime(runtime);
  const primary = transcriptProviderNameFor(resolveTranscriptionProviderPolicy(runtime).primary);
  const now = options.now ?? new Date();

  try {
    return await client.$transaction(async (tx) => {
      const operator = await tx.user.findUnique({
        where: { id: input.operatorUserId }, select: { id: true, isPlatformOperator: true },
      });
      assertPlatformOperator(operator);
      const program = await tx.editorialProgram.findUnique({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
      if (program && (program.state !== "NOT_STARTED" || program.startedAt !== null)) {
        refuse("PROGRAM_STARTED", "Sandbox setup is limited to preparation before the human-reference phase.");
      }

      // Use the same project lock as replacement. Source lock protects the later retention
      // extension against cleanup. Serializable isolation also catches non-cooperating writers.
      if (input.apply) {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${input.projectId}::uuid FOR UPDATE`;
      }
      const project = await tx.project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: {
          workspace: { select: { id: true, name: true, settings: true, updatedAt: true } },
          sourceVideo: { include: { transcript: { include: { _count: { select: { segments: true } } } } } },
          generatedClips: { orderBy: [{ rank: "asc" }, { id: "asc" }], include: { scheduledPosts: { select: { id: true } } } },
        },
      });
      if (!project) refuse("PROJECT_MISSING", "The service is not in the selected workspace.");
      if (project.status !== "READY") refuse("PROJECT_NOT_READY", "The service must be READY.");
      const source = project.sourceVideo;
      if (!source?.storageKey || source.workspaceId !== input.workspaceId) {
        refuse("SOURCE_MISSING", "The service needs a stored source in the same workspace.");
      }
      if (input.apply && !(await lockSourceVideoForRetention(tx, source.id))) {
        refuse("SOURCE_MISSING", "The source no longer exists.");
      }
      if (project.expiresAt && project.expiresAt <= now) refuse("SOURCE_EXPIRED", "The service has expired.");
      const transcript = source.transcript;
      if (!transcript || transcript.provider !== primary || transcript._count.segments === 0 || !transcript.fullText.trim()) {
        refuse("PRIMARY_TRANSCRIPT_REQUIRED", `The service needs a nonempty primary transcript (${primary}).`);
      }
      const hold = await tx.editorialException.findFirst({
        where: { projectId: project.id, state: "OPEN", exceptionType: "transcription_provider_fallback" }, select: { id: true },
      });
      if (hold) refuse("TRANSCRIPTION_HOLD", "The transcription hold is still open.");
      const activeJob = await tx.processingJob.findFirst({
        where: { projectId: project.id, state: { in: ["QUEUED", "RUNNING", "WAITING", "RETRYING"] } }, select: { id: true },
      });
      if (activeJob) refuse("PROCESSING_ACTIVE", "Wait for the service's processing jobs to finish.");
      const slots = await tx.scheduledPost.count({
        where: { OR: [{ projectId: project.id }, { clip: { projectId: project.id } }] },
      });
      if (slots > 0) refuse("SERVICE_ALREADY_SCHEDULED", "Use a fresh test service with no existing slots.");
      if (hasDurableWork(await countDurableWork(tx, { projectId: project.id }))) {
        refuse("DURABLE_WORK", "Use a fresh test service with no saved human edits, approvals, exports, or reviews.");
      }

      const durationMs = Number(source.durationS) * 1000;
      const candidates = project.generatedClips.map((row) => ({ ...row, isScheduled: row.scheduledPosts.length > 0 }));
      const rangeIsUsable = (row: typeof candidates[number]) => row.workspaceId === input.workspaceId &&
        row.supersededAt === null && row.startMs >= 0 && row.endMs <= durationMs;
      const clip = candidates.find((row) => row.id === input.clipId);
      if (!clip || !rangeIsUsable(clip) || !isPromotableReserve(clip, new Set())) {
        refuse("CLIP_INELIGIBLE", "The chosen clip must be an unused, retained range in this service.");
      }
      // Match REPLACE's policy before checking source coverage. Filtering invalid ranges first
      // could promise rank 3 here while the real replacement would still promote bad rank 2.
      const selection = selectReserve(candidates, { excludeClipIds: [clip.id] });
      const reserve = candidates.find((row) => row.id === selection.selected?.id);
      if (!reserve) refuse("NO_RESERVE", "Keep at least one unused same-service reserve for the replacement proof.");
      if (!rangeIsUsable(reserve)) refuse("RESERVE_INELIGIBLE", "The next reserve selected by REPLACE is not a usable source range.");

      const profile = parseChurchProfile(project.workspace.settings);
      const date = new Date(`${input.date}T00:00:00.000Z`);
      if (date < calendarDateInTimezone(now, profile.timezone)) refuse("DATE_IN_PAST", "The date has passed in the church's timezone.");
      if (date.getUTCDay() === 0) refuse("SUNDAY", "Sunday never receives a post.");
      const collision = await tx.scheduledPost.findFirst({
        where: { workspaceId: input.workspaceId, scheduledDate: date, publishStatus: { not: "MISSED" } }, select: { id: true },
      });
      if (collision) refuse("DATE_TAKEN", "This workspace already has a slot on that date.");
      const sourceExists = options.sourceExists ?? ((key: string) => getStorageProvider().exists(key));
      if (!(await sourceExists(source.storageKey))) refuse("SOURCE_MISSING", "The source object is missing from storage.");

      const extendedExpiry = sourceExpiresAtForSchedule([date]);
      // Null means no scheduled deletion. Do not introduce deletion as a side effect of setup.
      const expiresAt = project.expiresAt && extendedExpiry && extendedExpiry > project.expiresAt
        ? extendedExpiry : project.expiresAt;
      const describeClip = (row: typeof clip) => ({
        id: row.id, rank: row.rank, title: row.title, startMs: row.startMs, endMs: row.endMs,
        updatedAt: row.updatedAt.toISOString(),
      });
      const plan: SandboxSlotPlan = {
        version: 1, operatorUserId: operator.id,
        workspace: { id: project.workspace.id, name: project.workspace.name, updatedAt: project.workspace.updatedAt.toISOString() },
        project: { id: project.id, name: project.name, updatedAt: project.updatedAt.toISOString() },
        source: { id: source.id, updatedAt: source.updatedAt.toISOString(), transcriptId: transcript.id,
          transcriptUpdatedAt: transcript.updatedAt.toISOString(), provider: transcript.provider },
        clip: describeClip(clip), reserve: describeClip(reserve), date: input.date,
        platform: "FACEBOOK", timezone: profile.timezone, expiresAt: expiresAt?.toISOString() ?? null,
      };
      const confirmation = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      if (!input.apply) return { applied: false, plan, confirmation, scheduledPostId: null };
      if (input.confirmation !== confirmation) refuse("PLAN_CHANGED", "The plan changed. Run the read-only command again and review its new token.");
      checkRuntime(runtime);
      const slot = await tx.scheduledPost.create({
        data: { workspaceId: input.workspaceId, projectId: project.id, clipId: clip.id,
          scheduledDate: date, platform: "FACEBOOK", publishStatus: "NOT_STARTED" },
      });
      if (expiresAt && expiresAt.getTime() !== project.expiresAt?.getTime()) {
        await tx.project.update({ where: { id: project.id }, data: { expiresAt } });
      }
      // Platform-scoped: setup intent, actor, and reserve identity are staff-only audit data.
      // Failure must roll back the slot too; never use the best-effort recorder here.
      await recordOperationalEvent(tx, {
        category: "scheduling", eventType: "sandbox_slot_prepared",
        message: "An operator prepared one sandbox test slot.",
        metadata: { operatorUserId: operator.id, workspaceId: input.workspaceId,
          projectId: project.id, scheduledPostId: slot.id, clipId: clip.id,
          reserveClipId: reserve.id, date: input.date, confirmation },
      });
      return { applied: true, plan, confirmation, scheduledPostId: slot.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      refuse("CONCURRENT_CHANGE", "Another action changed this setup. Read and review a new plan; nothing was applied by this attempt.");
    }
    throw error;
  }
}
