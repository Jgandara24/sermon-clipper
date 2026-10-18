import { createHash, randomUUID } from "node:crypto";
import { Prisma, ProcessingJobState, ProcessingJobType, ProjectStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertWorkspacePermission } from "@/lib/authorization";
import { assertWorkspaceAccess } from "@/lib/billing/access";
import { parseChurchProfile } from "@/lib/church-profile";
import { recordOperationalEvent } from "@/lib/observability/operational-events";
import { assertPlatformOperator } from "@/lib/operator-auth";
import { readCandidateLimitOverride } from "@/lib/operations/candidate-limit-override";
import { sandboxServiceInputSchema, sandboxServicePlanInputSchema, type SandboxServiceInput } from "@/lib/operations/sandbox-service-input";
import { buildDraftProjectRecord, buildStatedServiceContext } from "@/lib/project-service";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";

const planInputSchema = sandboxServicePlanInputSchema;
export const sandboxServicePlanSchema = z.object({
  version: z.literal(1), input: planInputSchema, projectId: z.uuid(), jobId: z.uuid(),
  expiresAt: z.iso.datetime(), facts: z.object({
    copyOperationId: z.uuid(), copyPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    copyCompletedAt: z.iso.datetime(), copyRetainUntil: z.iso.datetime(), sourceUpdatedAt: z.iso.datetime(),
    workspaceUpdatedAt: z.iso.datetime(), memberUpdatedAt: z.iso.datetime(), durationSeconds: z.number().positive(),
  }).strict(),
}).strict();
export type SandboxServicePlan = z.infer<typeof sandboxServicePlanSchema>;

export class SandboxServiceRefused extends Error {
  constructor(readonly code: string) { super(`Sandbox service refused: ${code}`); }
}
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new SandboxServiceRefused(code);
}
function runtimeIsSafe(runtime: Record<string, string | undefined>) {
  for (const key of ["AUTOMATIC_PUBLISHING_ENABLED", "AUTOMATIC_SCHEDULE_ARMING_ENABLED",
    "SOURCE_RETENTION_DELETION_ENABLED"]) requireFact(runtime[key] === undefined || runtime[key] === "false", "AUTOMATION_NOT_OFF");
}
export function sandboxServicePlanHash(plan: SandboxServicePlan) {
  return createHash("sha256").update(JSON.stringify(sandboxServicePlanSchema.parse(plan))).digest("hex");
}
type Options = { now?: Date; runtime?: Record<string, string | undefined> };
type Client = PrismaClient | Prisma.TransactionClient;

async function readFacts(client: Client, input: z.infer<typeof planInputSchema>, now: Date) {
  assertPlatformOperator(await client.user.findUnique({ where: { id: input.operatorId },
    select: { id: true, isPlatformOperator: true } }));
  const member = await client.workspaceMember.findUnique({ where: { workspaceId_userId: {
    workspaceId: input.workspaceId, userId: input.importUserId } }, include: { workspace: true } });
  requireFact(member?.status === "ACTIVE", "TARGET_ACCESS_REQUIRED");
  assertWorkspacePermission(member.role, "IMPORT_MEDIA");
  assertWorkspaceAccess(member.workspace, "start_processing", now);
  const source = await client.sourceVideo.findUnique({ where: { id: input.sourceVideoId }, select: {
    id: true, workspaceId: true, updatedAt: true, durationS: true, storageKey: true, audioKey: true,
    thumbnailKey: true, srtOverrideKey: true, transcript: { select: { id: true } },
  } });
  requireFact(source?.workspaceId === input.workspaceId && source.storageKey, "COPIED_SOURCE_REQUIRED");
  requireFact(!source.audioKey && !source.thumbnailKey && !source.srtOverrideKey && !source.transcript, "SOURCE_NOT_FRESH");
  const durationSeconds = Number(source.durationS);
  requireFact(Number.isFinite(durationSeconds) && durationSeconds > 0, "DURATION_REQUIRED");
  requireFact(Number(member.workspace.minuteBalance) >= durationSeconds / 60, "MINUTES_REQUIRED");
  const copy = await client.sourceCopyOperation.findUnique({ where: { sourceVideoId: source.id } });
  requireFact(copy?.state === "COMPLETE" && copy.completedAt && copy.retainUntil > now &&
    copy.storageKey === source.storageKey, "COMPLETED_COPY_REQUIRED");
  const program = await client.editorialProgram.findUnique({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
  requireFact(!program || (program.state === "NOT_STARTED" && !program.startedAt), "PROGRAM_STARTED");
  return { copyOperationId: copy.id, copyPlanHash: copy.planHash,
    copyCompletedAt: copy.completedAt.toISOString(), copyRetainUntil: copy.retainUntil.toISOString(),
    sourceUpdatedAt: source.updatedAt.toISOString(), workspaceUpdatedAt: member.workspace.updatedAt.toISOString(),
    memberUpdatedAt: member.updatedAt.toISOString(), durationSeconds };
}

export async function planSandboxService(client: PrismaClient, raw: SandboxServiceInput, options: Options = {}) {
  runtimeIsSafe(options.runtime ?? process.env);
  const parsed = sandboxServiceInputSchema.parse(raw);
  requireFact(!parsed.apply, "PLAN_MUST_BE_READ_ONLY");
  const input = planInputSchema.parse({ operatorId: parsed.operatorId, importUserId: parsed.importUserId,
    workspaceId: parsed.workspaceId, sourceVideoId: parsed.sourceVideoId, name: parsed.name,
    sermonDate: parsed.sermonDate, occurrence: parsed.occurrence });
  const now = options.now ?? new Date();
  const facts = await readFacts(client, input, now);
  const plan: SandboxServicePlan = { version: 1, input, projectId: randomUUID(), jobId: randomUUID(),
    expiresAt: new Date(now.valueOf() + 30 * 60_000).toISOString(), facts };
  return { applied: false as const, plan, confirmation: sandboxServicePlanHash(plan) };
}

export async function applySandboxService(client: PrismaClient, rawPlan: SandboxServicePlan,
  confirmation: string, confirmedWorkspaceId: string, options: Options = {}) {
  runtimeIsSafe(options.runtime ?? process.env);
  const plan = sandboxServicePlanSchema.parse(rawPlan), now = options.now ?? new Date();
  requireFact(sandboxServicePlanHash(plan) === confirmation && confirmedWorkspaceId === plan.input.workspaceId,
    "CONFIRMATION_MISMATCH");
  requireFact(new Date(plan.expiresAt) > now, "PLAN_EXPIRED");
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${plan.input.sourceVideoId}::uuid FOR UPDATE`;
    const current = await readFacts(tx, plan.input, now);
    requireFact(JSON.stringify(current) === JSON.stringify(plan.facts), "PLAN_CHANGED");
    const existing = await tx.project.findUnique({ where: { id: plan.projectId }, include: { processingJobs: true } });
    if (existing) {
      requireFact(existing.workspaceId === plan.input.workspaceId && existing.sourceVideoId === plan.input.sourceVideoId &&
        existing.name === plan.input.name && existing.status === ProjectStatus.QUEUED &&
        existing.sermonDate?.toISOString().slice(0, 10) === plan.input.sermonDate &&
        existing.serviceSlot === plan.input.occurrence &&
        existing.processingJobs.length === 1 && existing.processingJobs[0].id === plan.jobId &&
        existing.processingJobs[0].type === ProcessingJobType.FINALIZE &&
        existing.processingJobs[0].state === ProcessingJobState.QUEUED &&
        existing.processingJobs[0].idempotencyKey === `finalize:${plan.projectId}` &&
        !existing.processingJobs[0].startedAt, "RESULT_CONFLICT");
      return { applied: true as const, reused: true, projectId: plan.projectId, jobId: plan.jobId };
    }
    requireFact(await tx.project.count({ where: { sourceVideoId: plan.input.sourceVideoId } }) === 0, "SOURCE_IN_USE");
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: plan.input.workspaceId } });
    const context = buildStatedServiceContext(parseChurchProfile(workspace.settings), {
      sermonDate: new Date(`${plan.input.sermonDate}T00:00:00.000Z`), serviceOccurrence: plan.input.occurrence });
    await tx.project.create({ data: { id: plan.projectId,
      ...buildDraftProjectRecord(plan.input.workspaceId, { name: plan.input.name }, plan.input.sourceVideoId,
        parseChurchProfile(workspace.settings), context, readCandidateLimitOverride(workspace.settings)),
      status: ProjectStatus.QUEUED } });
    await tx.processingJob.create({ data: { id: plan.jobId, projectId: plan.projectId,
      type: ProcessingJobType.FINALIZE, state: ProcessingJobState.QUEUED,
      idempotencyKey: `finalize:${plan.projectId}` } });
    await recordOperationalEvent(tx, { category: "processing", eventType: "sandbox_copied_source_handoff",
      message: "A staff-confirmed sandbox service was created from a copied source.",
      projectId: plan.projectId, jobId: plan.jobId, metadata: { operatorId: plan.input.operatorId,
        importUserId: plan.input.importUserId, workspaceId: plan.input.workspaceId,
        sourceVideoId: plan.input.sourceVideoId, copyOperationId: plan.facts.copyOperationId } });
    return { applied: true as const, reused: false, projectId: plan.projectId, jobId: plan.jobId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
