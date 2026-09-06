import { GeneratedClipStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { readCandidateLimit } from "@/lib/analysis/candidate-limit";
import { RETAINED_CLIP_STATUSES } from "@/lib/analysis/clip-status";
import {
  buildProjectPool,
  toChurchPool,
  type ChurchProjectPool,
  type OperatorProjectPool,
  type PoolClipFacts,
  type PoolSlotFacts,
} from "@/lib/candidates/project-pool";
import { env } from "@/lib/env";
import { readCandidateLimitOverride } from "@/lib/operations/candidate-limit-override";

/**
 * Loading one service's candidate pool.
 *
 * The only place that knows how to reach the facts `project-pool.ts` classifies. Two things are
 * deliberately awkward here rather than convenient:
 *
 * **Slots are read by the service that owns them, not by the clips they hold.** Reading a
 * project's clips and following each one to its slot would miss the case this read model exists
 * to present — a slot of *this* service filled by a clip from an older one. That candidate has no
 * row in this project's clip list, and a query written from the clip side cannot see it.
 *
 * **Nothing here derives a backup-to-primary mapping.** A reserve is not "the backup for slot 3";
 * it is a clip nothing has used yet. Persisting or inferring such a pairing is what the plan
 * rules out, and there is no field below that could carry one.
 */

type PoolQueryClient = PrismaClient | Prisma.TransactionClient;

/**
 * Every status a clip in the pool can hold — the retained pair, plus the two a person or a
 * replacement moves a clip into.
 *
 * The retained pair comes from the shared constant rather than being listed here: filtering
 * `SUGGESTED` out is what emptied every church's project page, and one source of truth for "what
 * analysis actually writes" is what stops that happening a third time.
 */
const POOL_STATUSES = [
  ...RETAINED_CLIP_STATUSES,
  GeneratedClipStatus.HIDDEN,
  GeneratedClipStatus.SUPERSEDED,
] as const;

export async function loadOperatorProjectPool(
  client: PoolQueryClient,
  params: { projectId: string },
): Promise<OperatorProjectPool | null> {
  const project = await client.project.findUnique({
    where: { id: params.projectId },
    select: {
      id: true,
      name: true,
      processingConfig: true,
      workspace: { select: { settings: true } },
      // Purged source media leaves the row and clears the key, so the key is the availability.
      sourceVideo: { select: { storageKey: true } },
    },
  });
  if (!project) return null;

  const clips = await client.generatedClip.findMany({
    where: { projectId: params.projectId, status: { in: [...POOL_STATUSES] } },
    orderBy: { rank: "asc" },
    select: {
      id: true,
      projectId: true,
      rank: true,
      status: true,
      supersededAt: true,
      title: true,
      hookText: true,
      startMs: true,
      endMs: true,
    },
  });

  // Every slot this service owns, whatever service its clip came from.
  const slots = await client.scheduledPost.findMany({
    where: { projectId: params.projectId },
    orderBy: { scheduledDate: "asc" },
    select: {
      id: true,
      projectId: true,
      clipId: true,
      scheduledDate: true,
      publishStatus: true,
      exportJob: { select: { id: true, state: true, qcStatus: true, editVersion: true, qcChecksum: true } },
      clip: {
        select: {
          id: true,
          projectId: true,
          rank: true,
          status: true,
          supersededAt: true,
          title: true,
          hookText: true,
          startMs: true,
          endMs: true,
        },
      },
    },
  });

  // Which clips a REPLACE promoted, asked only about the clips this pool actually presents.
  //
  // Scoped deliberately: `replacementClipIdSnapshot: { not: null }` would load every replacement
  // ever made in every workspace to answer a question about six clips, and that set only grows.
  // Read from the decision's immutable snapshot rather than the live link, so a clip whose
  // promoting review has since lost its foreign key still reads as a replacement.
  const presentedClipIds = [
    ...clips.map((clip) => clip.id),
    ...slots.map((slot) => slot.clip?.id).filter((id): id is string => Boolean(id)),
  ];
  const promotions =
    presentedClipIds.length > 0
      ? await client.clipReview.findMany({
          where: { decision: "REPLACE", replacementClipIdSnapshot: { in: presentedClipIds } },
          select: { replacementClipIdSnapshot: true },
        })
      : [];
  const promoted = new Set(
    promotions
      .map((row) => row.replacementClipIdSnapshot)
      .filter((id): id is string => id !== null),
  );

  const slotByClipId = new Map<string, PoolSlotFacts>();
  const borrowed: PoolClipFacts[] = [];

  // One review lookup per slot. A service has about six, so this stays a handful of indexed reads
  // rather than something worth batching into a query nobody can read.
  for (const slot of slots) {
    if (!slot.clip) continue;

    const job = slot.exportJob;
    const latest = await client.clipReview.findFirst({
      where: { scheduledPostIdSnapshot: slot.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        decision: true,
        clipIdSnapshot: true,
        exportJobIdSnapshot: true,
        editVersion: true,
        checksum: true,
      },
    });

    const facts: PoolSlotFacts = {
      scheduledPostId: slot.id,
      owningProjectId: slot.projectId,
      scheduledDate: slot.scheduledDate,
      publishStatus: slot.publishStatus,
      boundRender: job ? { exportJobId: job.id, state: job.state, qcStatus: job.qcStatus } : null,
      latestDecision: latest?.decision ?? null,
      // The same four facts delivery keys on (P2.8). A pool that said "accepted" about a file the
      // slot no longer holds would be repeating the defect one screen further out.
      decisionIsAboutBoundRender: Boolean(
        latest &&
          job &&
          latest.clipIdSnapshot === slot.clip.id &&
          latest.exportJobIdSnapshot === job.id &&
          latest.editVersion === job.editVersion &&
          latest.checksum === job.qcChecksum,
      ),
    };
    slotByClipId.set(slot.clip.id, facts);

    // A clip cut from an older service, filling one of this service's slots. It has no row in the
    // clip query above, so it is added here or it is invisible.
    if (slot.clip.projectId !== params.projectId) {
      borrowed.push({
        ...slot.clip,
        hookText: slot.clip.hookText,
        slot: facts,
        promotedByReplacement: promoted.has(slot.clip.id),
      });
    }
  }

  const own: PoolClipFacts[] = clips.map((clip) => ({
    ...clip,
    slot: slotByClipId.get(clip.id) ?? null,
    promotedByReplacement: promoted.has(clip.id),
  }));

  const override = readCandidateLimitOverride(project.workspace.settings);
  return buildProjectPool({
    projectId: project.id,
    projectName: project.name,
    clips: [...own, ...borrowed],
    renderSourceAvailable: Boolean(project.sourceVideo?.storageKey),
    limits: {
      // Frozen into the project at creation. Read from the project rather than recomputed, so a
      // settings edit today cannot change what a past service was allowed to retain.
      effectiveSnapshot: readCandidateLimit(project.processingConfig, {
        masterDefault: env.CANDIDATE_LIMIT_DEFAULT,
        masterMaximum: env.CANDIDATE_LIMIT_MAXIMUM,
      }),
      masterDefault: env.CANDIDATE_LIMIT_DEFAULT,
      hardMaximum: env.CANDIDATE_LIMIT_MAXIMUM,
      hiddenOverride: override ?? null,
    },
  });
}

/** The same pool, with every internal limit removed. */
export async function loadChurchProjectPool(
  client: PoolQueryClient,
  params: { projectId: string },
): Promise<ChurchProjectPool | null> {
  const pool = await loadOperatorProjectPool(client, params);
  return pool ? toChurchPool(pool) : null;
}
