import {
  AuthProvider,
  ClipReviewDecision,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
  SourceOrigin,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadChurchProjectPool, loadOperatorProjectPool } from "@/lib/candidates/query";
import { PROTECTED_WORKSPACE_SETTINGS_KEY } from "@/lib/workspace-settings";

/**
 * The pool read model against real rows.
 *
 * The unit tests own the classification; what only a database can prove is that the query finds
 * everything the classifier needs — in particular the borrowed fill, which has no row in its
 * host service's clip list and is reachable only through the slot.
 */

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
let sourceVideoId: string;
let serial = 0;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2044, 0, serial));
}

async function createProject(label: string) {
  return prisma.project.create({
    data: {
      workspaceId,
      sourceVideoId,
      name: `Pool ${label}`,
      processingConfig: { targetClipCount: 6, candidateLimit: 18 },
    },
  });
}

async function createClip(
  projectId: string,
  rank: number,
  options: { status?: GeneratedClipStatus; supersededAt?: Date } = {},
) {
  return prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank,
      startMs: rank * 10_000,
      endMs: rank * 10_000 + 45_000,
      title: `Candidate ${rank}`,
      hookText: `Hook ${rank}`,
      summary: "Pool fixture.",
      status: options.status ?? GeneratedClipStatus.KEPT,
      supersededAt: options.supersededAt ?? null,
    },
  });
}

async function createBoundExport(clipId: string, label: string) {
  const checksum = `sha256-${uniqueKey(label)}`;
  return prisma.exportJob.create({
    data: {
      workspaceId,
      clipId,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: uniqueKey(`pool-${label}`),
      filename: `${label}.mp4`,
      editVersion: 1,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: checksum,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("pool")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Candidate pool tests" },
  });
  workspaceId = workspace.id;
  const source = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "sermon.mp4",
      storageKey: `src/${workspaceId}/sermon.mp4`,
    },
  });
  sourceVideoId = source.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("one service's pool", () => {
  it("classifies a whole pool: scheduled, reserves in rank order, hidden and superseded", async () => {
    const project = await createProject("one-service");
    const scheduled = await createClip(project.id, 1);
    await createClip(project.id, 4);
    await createClip(project.id, 2);
    await createClip(project.id, 3, { status: GeneratedClipStatus.HIDDEN });
    await createClip(project.id, 5, { supersededAt: new Date() });
    // Never kept, so it is not in the pool at all — no presentation state describes it.
    await createClip(project.id, 6, { status: GeneratedClipStatus.SUGGESTED });

    const job = await createBoundExport(scheduled.id, "one-service");
    await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: scheduled.id,
        exportJobId: job.id,
        scheduledDate: nextDate(),
      },
    });

    const pool = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(pool?.candidates.map((row) => [row.rank, row.state])).toEqual([
      [1, "SCHEDULED"],
      [2, "RESERVE"],
      [3, "HIDDEN"],
      [4, "RESERVE"],
      [5, "SUPERSEDED"],
    ]);
    expect(pool?.reserveQueue.map((row) => row.rank)).toEqual([2, 4]);
    expect(pool?.retainedCount).toBe(5);
    expect(pool?.renderSourceAvailable).toBe(true);
  });

  it("reports a thin pool without inventing anything to fill it", async () => {
    const project = await createProject("thin");
    await createClip(project.id, 1);

    const pool = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(pool?.retainedCount).toBe(1);
    expect(pool?.reserveQueue).toHaveLength(1);
    expect(pool?.candidates[0].state).toBe("RESERVE");
  });

  it("reports an unfilled slot by leaving the pool's candidates alone", async () => {
    const project = await createProject("unfilled");
    await createClip(project.id, 1);
    // What P2.7 leaves when a replacement finds no reserve: the slot keeps its date and its
    // project, and holds no clip.
    await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: null,
        scheduledDate: nextDate(),
        publishStatus: SchedulePublishStatus.UNFILLED,
      },
    });

    const pool = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(pool?.candidates).toHaveLength(1);
    expect(pool?.candidates[0].state).toBe("RESERVE");
    expect(pool?.candidates[0].scheduledDate).toBeNull();
  });

  it("returns nothing for a service that does not exist", async () => {
    await expect(
      loadOperatorProjectPool(prisma, { projectId: "00000000-0000-4000-8000-000000000000" }),
    ).resolves.toBeNull();
  });
});

describe("a replacement, and a clip borrowed from an older service", () => {
  it("calls this service's promoted clip a selected replacement", async () => {
    const project = await createProject("replacement");
    const rejected = await createClip(project.id, 1, { supersededAt: new Date() });
    const promoted = await createClip(project.id, 2);

    const job = await createBoundExport(promoted.id, "replacement");
    const slot = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: promoted.id,
        exportJobId: job.id,
        scheduledDate: nextDate(),
      },
    });
    await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: project.id,
        scheduledPostIdSnapshot: slot.id,
        clipIdSnapshot: rejected.id,
        clipRank: 1,
        clipStartMs: 10_000,
        clipEndMs: 55_000,
        exportJobIdSnapshot: job.id,
        editVersion: 1,
        checksum: job.qcChecksum as string,
        decision: ClipReviewDecision.REPLACE,
        replacementClipIdSnapshot: promoted.id,
        reviewerUserId: userId,
      },
    });

    const pool = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(pool?.candidates.map((row) => [row.rank, row.state])).toEqual([
      [1, "SUPERSEDED"],
      [2, "SELECTED_REPLACEMENT"],
    ]);
    // Rank is the selector's ordering; promotion does not renumber it.
    expect(pool?.candidates[1].rank).toBe(2);
  });

  /**
   * The case this read model exists for, and the one a clip-side query cannot see.
   *
   * The borrowed clip has no row in the host service's clip list — it belongs to an older
   * sermon — so it is reachable only through the slot the host service owns.
   */
  it("finds a clip borrowed from an older service, and does not call it a replacement", async () => {
    const older = await createProject("borrow-source");
    const host = await createProject("borrow-host");
    await createClip(host.id, 1);
    const borrowed = await createClip(older.id, 3);

    const job = await createBoundExport(borrowed.id, "borrowed");
    const slot = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: host.id,
        clipId: borrowed.id,
        exportJobId: job.id,
        scheduledDate: nextDate(),
      },
    });
    // Promoted by a REPLACE, which is usually how a borrowed clip reaches a slot. It must still
    // read as a prior-service fill: the host service produced no replacement of its own.
    await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: host.id,
        scheduledPostIdSnapshot: slot.id,
        clipIdSnapshot: borrowed.id,
        clipRank: 3,
        clipStartMs: 30_000,
        clipEndMs: 75_000,
        exportJobIdSnapshot: job.id,
        editVersion: 1,
        checksum: job.qcChecksum as string,
        decision: ClipReviewDecision.REPLACE,
        replacementClipIdSnapshot: borrowed.id,
        reviewerUserId: userId,
      },
    });

    const pool = await loadOperatorProjectPool(prisma, { projectId: host.id });
    const fill = pool?.candidates.find((row) => row.clipId === borrowed.id);
    expect(fill).toMatchObject({
      state: "PRIOR_SERVICE_FILL",
      borrowedFromProjectId: older.id,
      rank: 3,
    });
    // Presented here, but it is the older service's candidate and is not counted as this one's.
    expect(pool?.retainedCount).toBe(1);
    expect(pool?.candidates).toHaveLength(2);

    // And in its own service it is simply a scheduled clip, because the slot is not that
    // service's to own.
    const home = await loadOperatorProjectPool(prisma, { projectId: older.id });
    expect(home?.candidates.find((row) => row.clipId === borrowed.id)?.state).toBe("RESERVE");
  });
});

describe("the render and the decision a slot carries", () => {
  it("says whether the standing decision is about the file the slot holds now", async () => {
    const project = await createProject("decision");
    const clip = await createClip(project.id, 1);
    const job = await createBoundExport(clip.id, "decision");
    const slot = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: clip.id,
        exportJobId: job.id,
        scheduledDate: nextDate(),
      },
    });
    await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: project.id,
        scheduledPostIdSnapshot: slot.id,
        clipIdSnapshot: clip.id,
        clipRank: 1,
        clipStartMs: 10_000,
        clipEndMs: 55_000,
        exportJobIdSnapshot: job.id,
        editVersion: 1,
        checksum: job.qcChecksum as string,
        decision: ClipReviewDecision.ACCEPT,
        reviewerUserId: userId,
      },
    });

    const accepted = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(accepted?.candidates[0].review).toEqual({
      latestDecision: ClipReviewDecision.ACCEPT,
      isAboutBoundRender: true,
    });
    expect(accepted?.candidates[0].boundRender).toMatchObject({
      exportJobId: job.id,
      state: ProcessingJobState.SUCCEEDED,
      qcStatus: RenderQcStatus.PASSED,
    });

    // A rebuild of the same export: same id, different bytes. The decision stands on the record
    // and stops being about this file — the same four facts delivery keys on (P2.8).
    await prisma.exportJob.update({
      where: { id: job.id },
      data: { qcChecksum: `sha256-${uniqueKey("rebuilt")}` },
    });
    const stale = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(stale?.candidates[0].review).toEqual({
      latestDecision: ClipReviewDecision.ACCEPT,
      isAboutBoundRender: false,
    });
  });

  it("says the render source is gone once the media has been purged", async () => {
    const purged = await prisma.sourceVideo.create({
      data: { workspaceId, origin: SourceOrigin.UPLOAD, filename: "gone.mp4", storageKey: null },
    });
    const project = await prisma.project.create({
      data: { workspaceId, sourceVideoId: purged.id, name: "Pool purged", processingConfig: {} },
    });
    await createClip(project.id, 1);

    const pool = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(pool?.renderSourceAvailable).toBe(false);
    expect(pool?.candidates[0].renderSourceAvailable).toBe(false);
  });
});

describe("what each role is handed", () => {
  it("keeps the project's frozen limit even after the workspace default changes", async () => {
    const project = await createProject("snapshot");
    await createClip(project.id, 1);

    const before = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(before?.limits.effectiveSnapshot).toBe(18);

    // A settings edit today must not rewrite what a past service was allowed to retain.
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { settings: { [PROTECTED_WORKSPACE_SETTINGS_KEY]: { candidateLimitOverride: 9 } } },
    });
    const after = await loadOperatorProjectPool(prisma, { projectId: project.id });
    expect(after?.limits.effectiveSnapshot).toBe(18);
    expect(after?.limits.hiddenOverride).toBe(9);

    await prisma.workspace.update({ where: { id: workspaceId }, data: { settings: {} } });
  });

  it("hands a church the same pool with no internal limit and no selector fact", async () => {
    const project = await createProject("church-shape");
    await createClip(project.id, 1);

    const church = await loadChurchProjectPool(prisma, { projectId: project.id });
    expect(church).not.toBeNull();
    expect("limits" in (church as object)).toBe(false);

    const serialised = JSON.stringify(church);
    for (const forbidden of [
      "hardMaximum",
      "masterDefault",
      "effectiveSnapshot",
      "hiddenOverride",
      "score",
      "subscores",
      "rationale",
      "excerpt",
      "modelVersion",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
