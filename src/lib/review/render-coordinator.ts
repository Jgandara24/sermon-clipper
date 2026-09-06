import { SchedulePublishStatus, type PrismaClient } from "@prisma/client";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { DEFAULT_EDIT_VERSION } from "@/lib/exports/edit-version";
import { enqueueExportJob } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { automaticPublishingEnabled } from "@/lib/worker/reliability";

/**
 * Gives every scheduled slot the exact file it will publish.
 *
 * Before this, nothing created an export automatically: a church exported by hand from the
 * editor, and the publisher skipped any slot whose clip had no finished render. That was an
 * accidental safety barrier rather than a designed one, and P1.11 replaced it with a real
 * eligibility module. This is the other half — the thing that makes a scheduled slot actually
 * have a file to be eligible about.
 *
 * Run in two places, and idempotent so that is safe: once after analysis, for the slots that run
 * has just armed, and again on a periodic sweep. The sweep is what catches a slot armed while
 * automatic publishing was off — enabling the switch later must not strand work that was created
 * before it, and a slot with no bound export is invisible to the publisher forever otherwise.
 *
 * **It records no export work while the switch is off.** Not "enqueues and holds" — nothing at
 * all, no job row, no binding, no cost. The switch is the last thing standing between this
 * repository and a real church's Facebook page, and a coordinator that quietly built a queue
 * behind it would make flipping it far more dangerous than it looks.
 */

export type ScheduledRenderOutcome = {
  /** False when the switch is off. Every other number is zero and nothing was written. */
  enabled: boolean;
  slotsScanned: number;
  /** Slots that gained a binding this run, whether the job was created or reused. */
  slotsBound: number;
  /** Export jobs created. Lower than `slotsBound` when a manual render already existed. */
  jobsCreated: number;
  failures: { scheduledPostId: string; message: string }[];
};

const EMPTY_DISABLED_OUTCOME: ScheduledRenderOutcome = {
  enabled: false,
  slotsScanned: 0,
  slotsBound: 0,
  jobsCreated: 0,
  failures: [],
};

/** How many slots one sweep will take. Bounds a backlog into several passes rather than one. */
const DEFAULT_SWEEP_LIMIT = 25;

export async function coordinateScheduledRenders(
  client: PrismaClient,
  options?: { projectId?: string; limit?: number; publishingEnabled?: boolean },
): Promise<ScheduledRenderOutcome> {
  const enabled = options?.publishingEnabled ?? automaticPublishingEnabled();
  if (!enabled) return { ...EMPTY_DISABLED_OUTCOME };

  // Only slots with a clip, no export, and a state that has not started publishing. A slot that
  // is BLOCKED, UNFILLED or MISSED is not waiting for a file, and one already IN_PROGRESS or
  // SUCCEEDED has the file it published.
  const slots = await client.scheduledPost.findMany({
    where: {
      publishStatus: SchedulePublishStatus.NOT_STARTED,
      exportJobId: null,
      clipId: { not: null },
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    },
    include: { clip: { include: { project: true } } },
    orderBy: { scheduledDate: "asc" },
    take: options?.limit ?? DEFAULT_SWEEP_LIMIT,
  });

  const outcome: ScheduledRenderOutcome = {
    enabled: true,
    slotsScanned: slots.length,
    slotsBound: 0,
    jobsCreated: 0,
    failures: [],
  };

  for (const slot of slots) {
    const clip = slot.clip;
    if (!clip) continue;
    try {
      // The newest saved document is what this slot will publish, pinned onto the job here so a
      // save landing before the worker starts cannot change what gets rendered (P1.1). A clip
      // nobody has edited renders its machine-written default, which is version 0.
      const latestEdit = await client.clipEdit.findFirst({
        where: { clipId: clip.id },
        orderBy: { version: "desc" },
      });
      const editVersion = latestEdit?.version ?? DEFAULT_EDIT_VERSION;

      const before = await client.exportJob.count({ where: { clipId: clip.id, editVersion } });
      const job = await enqueueExportJob(client, {
        clipId: clip.id,
        workspaceId: slot.workspaceId,
        editVersion,
        filename: buildDefaultExportFilename({
          seriesOrProject: clip.project.series ?? clip.project.name,
          clipTitle: clip.title,
          date: slot.scheduledDate,
        }),
      });
      if (before === 0) outcome.jobsCreated += 1;

      // Conditional on the binding still being empty, so two sweeps racing each other cannot
      // fight over one slot. Both would reach the same job — the idempotency key is the clip and
      // the edit version — so the loser has nothing to correct, it simply did not write.
      const bound = await client.scheduledPost.updateMany({
        where: { id: slot.id, exportJobId: null, clipId: clip.id },
        data: { exportJobId: job.id },
      });
      if (bound.count > 0) outcome.slotsBound += 1;
    } catch (error) {
      // One bad slot must not strand the rest of the sweep. The failure is recorded and the loop
      // carries on; the next sweep tries this slot again.
      const message = error instanceof Error ? error.message : String(error);
      outcome.failures.push({ scheduledPostId: slot.id, message });
      await recordOperationalEventSafely(client, {
        workspaceId: slot.workspaceId,
        category: "export",
        eventType: "scheduled_render_enqueue_failed",
        severity: "error",
        message: "Could not enqueue the render for a scheduled slot.",
        projectId: slot.projectId,
        clipId: slot.clipId,
        metadata: { scheduledPostId: slot.id, reason: message },
      });
    }
  }

  if (outcome.slotsBound > 0 || outcome.failures.length > 0) {
    await recordOperationalEventSafely(client, {
      category: "export",
      eventType: "scheduled_renders_coordinated",
      severity: outcome.failures.length > 0 ? "warning" : "info",
      message: "Enqueued renders for scheduled slots.",
      metadata: {
        projectId: options?.projectId ?? null,
        slotsScanned: outcome.slotsScanned,
        slotsBound: outcome.slotsBound,
        jobsCreated: outcome.jobsCreated,
        failures: outcome.failures.length,
      },
    });
  }

  return outcome;
}
