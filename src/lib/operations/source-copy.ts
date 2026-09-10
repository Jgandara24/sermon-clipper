import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertWorkspaceAccess } from "@/lib/billing/access";
import { assertWorkspacePermission } from "@/lib/authorization";
import { assertPlatformOperator } from "@/lib/operator-auth";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
});
export const copyInputSchema = z.object({
  operatorId: z.uuid(), importUserId: z.uuid(), workspaceId: z.uuid(), projectId: z.uuid(),
  sermonDate: date, occurrence: z.enum(["PRIMARY", "SECONDARY", "UNMATCHED"]),
  maxBytes: z.number().int().positive().max(500_000_000),
}).strict();
export type CopyInput = z.infer<typeof copyInputSchema>;
export type ObjectIdentity = { bytes: number; etag: string; sha256: string; owner: string | null; versionId: string | null; lastModified: string | null };
export interface CopyStorage {
  /** Stable non-secret backend/bucket identity. Included in the approved manifest. */
  identity: string;
  inspect(key: string, maxBytes: number): Promise<ObjectIdentity | null>;
  copy(source: string, destination: string, etag: string, operationId: string): Promise<void>;
}
export class SourceCopyRefused extends Error {
  constructor(readonly code: string) { super(`Source copy refused: ${code}`); }
}
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new SourceCopyRefused(code);
}
const identitySchema = z.object({ bytes: z.number().int().positive(), etag: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().nullable(), versionId: z.string().nullable(), lastModified: z.iso.datetime().nullable() }).strict();
export const copyManifestSchema = z.object({
  version: z.literal(1), input: copyInputSchema, operationId: z.uuid(), destinationId: z.uuid(),
  destinationKey: z.string(), backend: z.string(), expiresAt: z.iso.datetime(), retainUntil: z.iso.datetime(),
  facts: z.object({ sourceId: z.uuid(), sourceKey: z.string(), sourceUpdatedAt: z.string(),
    projectUpdatedAt: z.string(), sourceWorkspaceId: z.uuid(), oldDate: z.string().nullable(),
    duration: z.number().positive(), language: z.string().nullable(), workspaceName: z.string(),
    workspaceUpdatedAt: z.string(), memberUpdatedAt: z.string(), sourceMemberUpdatedAt: z.string(),
  }).strict(),
  object: identitySchema,
  cost: z.object({ sourceReadBytes: z.number(), copyBytes: z.number(), verificationReadBytes: z.number(),
    retainedBytes: z.number(), usd: z.null(), pricing: z.literal("NOT_CONFIGURED") }).strict(),
}).strict();
export type CopyManifest = z.infer<typeof copyManifestSchema>;
export function copyPlanHash(plan: CopyManifest) {
  // Parsing fixes property order and rejects unknown fields, including edited manifests.
  return createHash("sha256").update(JSON.stringify(copyManifestSchema.parse(plan))).digest("hex");
}
type Client = Prisma.TransactionClient;
type Options = { clock?: () => Date; now?: Date; runtime?: Record<string, string | undefined> };
function currentTime(options: Options) { return options.clock?.() ?? options.now ?? new Date(); }
function checkRuntime(options: Options) {
  const env = options.runtime ?? process.env;
  for (const key of ["AUTOMATIC_PUBLISHING_ENABLED", "AUTOMATIC_SCHEDULE_ARMING_ENABLED", "SOURCE_RETENTION_DELETION_ENABLED"]) {
    requireFact(env[key] === undefined || env[key] === "false", "AUTOMATION_NOT_OFF");
  }
}
async function facts(tx: Client, input: CopyInput, now: Date) {
  assertPlatformOperator(await tx.user.findUnique({ where: { id: input.operatorId },
    select: { id: true, isPlatformOperator: true } }));
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: {
    id: true, updatedAt: true, workspaceId: true, sourceVideoId: true, sermonDate: true, expiresAt: true,
    sourceVideo: { select: { id: true, updatedAt: true, workspaceId: true, storageKey: true, durationS: true, language: true } },
  } });
  requireFact(project?.sourceVideo?.storageKey, "SOURCE_MISSING");
  const source = project.sourceVideo;
  requireFact(source.workspaceId === project.workspaceId && source.workspaceId !== input.workspaceId, "SOURCE_WORKSPACE_INVALID");
  requireFact(!project.expiresAt || project.expiresAt > now, "SOURCE_EXPIRED");
  const duration = Number(source.durationS);
  requireFact(duration > 0 && Number.isFinite(duration), "DURATION_MISSING");
  // The staff marker is not tenant write authority. Require source membership as well
  // as a named active importing member in the destination.
  const sourceMember = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: {
    workspaceId: source.workspaceId, userId: input.operatorId } } });
  requireFact(sourceMember?.status === "ACTIVE", "SOURCE_ACCESS_REQUIRED");
  assertWorkspacePermission(sourceMember.role, "IMPORT_MEDIA");
  const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: {
    workspaceId: input.workspaceId, userId: input.importUserId } }, include: { workspace: true } });
  requireFact(member?.status === "ACTIVE", "TARGET_ACCESS_REQUIRED");
  assertWorkspacePermission(member.role, "IMPORT_MEDIA");
  assertWorkspaceAccess(member.workspace, "import_media", now);
  requireFact(Number(member.workspace.minuteBalance) >= duration / 60, "MINUTES_REQUIRED");
  const program = await tx.editorialProgram.findUnique({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
  requireFact(!program || (program.state === "NOT_STARTED" && !program.startedAt), "PROGRAM_STARTED");
  const busy = await tx.processingJob.count({ where: { project: { sourceVideoId: source.id },
    state: { in: ["QUEUED", "RUNNING", "WAITING", "RETRYING"] } } });
  requireFact(!busy, "SOURCE_PROCESSING_ACTIVE");
  return { sourceId: source.id, sourceKey: source.storageKey!, sourceUpdatedAt: source.updatedAt.toISOString(),
    projectUpdatedAt: project.updatedAt.toISOString(), sourceWorkspaceId: source.workspaceId,
    oldDate: project.sermonDate?.toISOString().slice(0, 10) ?? null, duration, language: source.language,
    workspaceName: member.workspace.name, workspaceUpdatedAt: member.workspace.updatedAt.toISOString(),
    memberUpdatedAt: member.updatedAt.toISOString(), sourceMemberUpdatedAt: sourceMember.updatedAt.toISOString() };
}
export async function planSourceCopy(client: PrismaClient, storage: CopyStorage, raw: CopyInput, options: Options = {}) {
  checkRuntime(options);
  const input = copyInputSchema.parse(raw), now = currentTime(options);
  const snapshot = await facts(client, input, now);
  const object = identitySchema.parse(await storage.inspect(snapshot.sourceKey, input.maxBytes));
  requireFact(object.bytes <= input.maxBytes, "SOURCE_TOO_LARGE");
  // Recheck after the bounded object read. No database/storage writes, even an audit.
  requireFact(JSON.stringify(snapshot) === JSON.stringify(await facts(client, input, currentTime(options))), "SOURCE_CHANGED");
  const destinationId = randomUUID();
  const plan: CopyManifest = { version: 1, input, operationId: randomUUID(), destinationId,
    destinationKey: `src/${input.workspaceId}/${destinationId}-sandbox-copy.mp4`, backend: storage.identity,
    expiresAt: new Date(now.valueOf() + 30 * 60_000).toISOString(),
    retainUntil: new Date(now.valueOf() + 24 * 3600_000).toISOString(), facts: snapshot, object,
    cost: { sourceReadBytes: object.bytes * 2, copyBytes: object.bytes, verificationReadBytes: object.bytes,
      retainedBytes: object.bytes, usd: null, pricing: "NOT_CONFIGURED" } };
  return { applied: false, plan, confirmation: copyPlanHash(plan) };
}
export async function applySourceCopy(client: PrismaClient, storage: CopyStorage, raw: CopyManifest,
  confirmation: string, confirmedWorkspace: string, options: Options = {}) {
  checkRuntime(options);
  const plan = copyManifestSchema.parse(raw), now = currentTime(options);
  const hash = copyPlanHash(plan);
  requireFact(hash === confirmation && confirmedWorkspace === plan.input.workspaceId, "CONFIRMATION_MISMATCH");
  requireFact(plan.backend === storage.identity && plan.destinationKey ===
    `src/${plan.input.workspaceId}/${plan.destinationId}-sandbox-copy.mp4`, "DESTINATION_MISMATCH");
  requireFact(new Date(plan.expiresAt) > now && new Date(plan.expiresAt).valueOf() <= now.valueOf() + 30 * 60_000,
    "PLAN_EXPIRED");
  requireFact(new Date(plan.retainUntil) > now && new Date(plan.retainUntil).valueOf() <= now.valueOf() + 24 * 3600_000,
    "RETENTION_INVALID");
  requireFact(JSON.stringify(await facts(client, plan.input, now)) === JSON.stringify(plan.facts), "FACTS_CHANGED");
  // Durable intent precedes the storage side effect. Never update a conflicting manifest.
  await client.sourceCopyOperation.upsert({ where: { id: plan.operationId }, update: {}, create: {
    id: plan.operationId, planHash: hash, manifest: plan, sourceVideoId: plan.destinationId,
    storageKey: plan.destinationKey, retainUntil: new Date(plan.retainUntil),
  } });
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM source_copy_operations WHERE id = ${plan.operationId}::uuid FOR UPDATE`;
    const op = await tx.sourceCopyOperation.findUniqueOrThrow({ where: { id: plan.operationId } });
    requireFact(op.planHash === hash, "OPERATION_CONFLICT");
    // Match TRANSCRIBE, ANALYZE, and retention: project before source. Taking the
    // source first can deadlock with a writer that already holds the project.
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${plan.input.projectId}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${plan.facts.sourceId}::uuid FOR UPDATE`;
    // Prevent permission revocation, expiry edits, and entitlement changes between
    // the final access check and registration. Locks are held only during apply.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${plan.input.operatorId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${plan.input.workspaceId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM workspace_members WHERE
      (workspace_id = ${plan.input.workspaceId}::uuid AND user_id = ${plan.input.importUserId}::uuid) OR
      (workspace_id = ${plan.facts.sourceWorkspaceId}::uuid AND user_id = ${plan.input.operatorId}::uuid)
      ORDER BY id FOR SHARE`;
    requireFact(JSON.stringify(await facts(tx, plan.input, currentTime(options))) === JSON.stringify(plan.facts), "FACTS_CHANGED");
    const existingRow = await tx.sourceVideo.findUnique({ where: { id: plan.destinationId },
      select: { storageKey: true, workspaceId: true, _count: { select: { projects: true } } } });
    if (existingRow) {
      requireFact(op.state === "COMPLETE" && existingRow.storageKey === plan.destinationKey &&
        existingRow.workspaceId === plan.input.workspaceId, "DESTINATION_CONFLICT");
    } else requireFact(op.state === "PREPARED", "REGISTERED_SOURCE_MISSING");
    const source = await storage.inspect(plan.facts.sourceKey, plan.input.maxBytes);
    requireFact(source && JSON.stringify(identitySchema.parse(source)) === JSON.stringify(plan.object), "SOURCE_CHANGED");
    let copied = await storage.inspect(plan.destinationKey, plan.input.maxBytes);
    if (!copied) {
      requireFact(op.state !== "COMPLETE", "REGISTERED_OBJECT_MISSING");
      requireFact(new Date(plan.expiresAt) > currentTime(options), "PLAN_EXPIRED");
      requireFact(JSON.stringify(await facts(tx, plan.input, currentTime(options))) === JSON.stringify(plan.facts), "FACTS_CHANGED");
      await storage.copy(plan.facts.sourceKey, plan.destinationKey, plan.object.etag, plan.operationId);
      copied = await storage.inspect(plan.destinationKey, plan.input.maxBytes);
    }
    requireFact(copied?.owner === plan.operationId && copied.bytes === plan.object.bytes &&
      copied.sha256 === plan.object.sha256, "COPY_VERIFICATION_FAILED");
    requireFact(new Date(plan.expiresAt) > currentTime(options), "PLAN_EXPIRED");
    // Locks and fresh time checks protect access through registration.
    requireFact(JSON.stringify(await facts(tx, plan.input, currentTime(options))) === JSON.stringify(plan.facts), "FACTS_CHANGED");
    if (!existingRow) {
      await tx.sourceVideo.create({ data: { id: plan.destinationId, workspaceId: plan.input.workspaceId,
        origin: "UPLOAD", filename: "sandbox-copy.mp4", storageKey: plan.destinationKey,
        sizeBytes: BigInt(copied.bytes), durationS: plan.facts.duration, language: plan.facts.language } });
      await tx.sourceCopyOperation.update({ where: { id: plan.operationId }, data: { state: "COMPLETE", completedAt: now } });
    }
    return { applied: true, reused: Boolean(existingRow), sourceVideoId: plan.destinationId,
      operationId: plan.operationId, sermonDate: plan.input.sermonDate, occurrence: plan.input.occurrence,
      retainUntil: plan.retainUntil, jobsCreated: 0, verifiedBytes: copied.bytes,
      cleanup: "REVIEW_REQUIRED_AFTER_RETENTION; NO_AUTOMATIC_DELETE" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 5_000 });
}
