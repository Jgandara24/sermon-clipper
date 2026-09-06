import {
  AuthProvider,
  ClipReviewDecision,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
  ReviewFeedbackCategory,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExportIdempotencyKey } from "@/lib/exports/edit-version";
import { claimNextExportJob } from "@/lib/exports/queue";
import {
  replaceScheduledClip,
  ReplacementRefusedError,
  REPLACEMENT_EXPORT_PRIORITY,
} from "@/lib/review/replace-scheduled-clip";
import { appendClipReview } from "@/lib/review/service";
import { StaleRenderError } from "@/lib/review/types";

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
let sourceVideoId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2041, 0, serial));
}

async function createClip(
  projectId: string,
  rank: number,
  status: GeneratedClipStatus = GeneratedClipStatus.KEPT,
) {
  serial += 1;
  return prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank,
      startMs: rank * 10_000,
      endMs: rank * 10_000 + 60_000,
      title: `Clip rank ${rank}`,
      summary: "Replacement fixture.",
      status,
    },
  });
}

async function createBoundExport(clipId: string, label: string) {
  serial += 1;
  return prisma.exportJob.create({
    data: {
      workspaceId,
      clipId,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `replace-${label}-${serial}`,
      filename: `${label}.mp4`,
      editVersion: 1,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: `sha256:${label}-${serial}`,
    },
  });
}

/** A project with one scheduled clip and however many reserves the test asks for. */
async function createSermon(label: string, reserveRanks: number[]) {
  serial += 1;
  const project = await prisma.project.create({
    data: { workspaceId, sourceVideoId, name: `Sermon ${label} ${serial}`, series: "Mornings" },
  });
  const scheduled = await createClip(project.id, 1);
  const exportJob = await createBoundExport(scheduled.id, label);
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId: project.id,
      clipId: scheduled.id,
      exportJobId: exportJob.id,
      scheduledDate: nextDate(),
    },
  });
  const reserves = [];
  for (const rank of reserveRanks) reserves.push(await createClip(project.id, rank));

  return {
    project,
    scheduled,
    exportJob,
    slot,
    reserves,
    identity: {
      clipId: scheduled.id,
      exportJobId: exportJob.id,
      editVersion: 1,
      checksum: exportJob.qcChecksum as string,
    },
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `replace-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Replacement tests" },
  });
  workspaceId = workspace.id;
  const source = await prisma.sourceVideo.create({
    data: { workspaceId, origin: "UPLOAD", storageKey: `${workspace.id}/src/replace.mp4` },
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

describe("one replacement, all at once", () => {
  it("supersedes, promotes, rebinds, queues a priority render and records the decision", async () => {
    const sermon = await createSermon("happy", [4, 2, 7]);

    const outcome = await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
      note: "The point never lands.",
      feedback: [{ category: ReviewFeedbackCategory.CONTENT, note: "Wanders after the hook." }],
    });

    // The lowest-ranked reserve, not merely any of them.
    const expected = sermon.reserves.find((clip) => clip.rank === 2);
    expect(outcome.promotedClipId).toBe(expected?.id);
    expect(outcome.slotStatus).toBe(SchedulePublishStatus.NOT_STARTED);
    expect(outcome.editorialExceptionId).toBeNull();

    // The rejected clip is superseded.
    await expect(
      prisma.generatedClip.findUniqueOrThrow({ where: { id: sermon.scheduled.id } }),
    ).resolves.toMatchObject({ status: GeneratedClipStatus.SUPERSEDED });
    const superseded = await prisma.generatedClip.findUniqueOrThrow({
      where: { id: sermon.scheduled.id },
    });
    expect(superseded.supersededAt).not.toBeNull();

    // The slot holds the reserve and the reserve's own render, and kept its date and platform.
    const slot = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: sermon.slot.id },
      include: { exportJob: true },
    });
    expect(slot.clipId).toBe(expected?.id);
    expect(slot.exportJobId).toBe(outcome.promotedExportJobId);
    expect(slot.exportJob?.clipId).toBe(expected?.id);
    expect(slot.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);
    expect(slot.scheduledDate.toISOString()).toBe(sermon.slot.scheduledDate.toISOString());
    expect(slot.platform).toBe(sermon.slot.platform);

    // The render jumps the queue: an operator is waiting on it.
    expect(slot.exportJob?.priority).toBe(REPLACEMENT_EXPORT_PRIORITY);

    // And the decision names both clips, so the lineage is readable later.
    const review = await prisma.clipReview.findUniqueOrThrow({
      where: { id: outcome.clipReviewId },
      include: { feedback: true },
    });
    expect(review.decision).toBe(ClipReviewDecision.REPLACE);
    expect(review.clipIdSnapshot).toBe(sermon.scheduled.id);
    expect(review.replacementClipIdSnapshot).toBe(expected?.id);
    expect(review.replacementClipRank).toBe(2);
    expect(review.replacementExportJobIdSnapshot).toBe(outcome.promotedExportJobId);
    expect(review.feedback).toHaveLength(1);
    expect(review.feedback[0].actionability).toBe("REPLACE_ONLY");
  });

  it("extends the source's retention so the new render outlives its posting date", async () => {
    const sermon = await createSermon("retention", [3]);
    await prisma.project.update({
      where: { id: sermon.project.id },
      data: { expiresAt: new Date(Date.UTC(2020, 0, 1)) },
    });

    await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
    });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: sermon.project.id } });
    expect(project.expiresAt).not.toBeNull();
    // Past the slot's own date: the file has to survive until it posts, plus the tail.
    expect(project.expiresAt!.getTime()).toBeGreaterThan(sermon.slot.scheduledDate.getTime());
  });

  it("reuses an existing render for the reserve rather than minting a second", async () => {
    const sermon = await createSermon("reuse", [5]);
    const reserve = sermon.reserves[0];
    // The identity `enqueueExportJob` will compute: nobody has edited this reserve, so its pinned
    // version is the machine's own document. A hand-written key would not match and the test
    // would prove the opposite of what it claims.
    const existing = await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: reserve.id,
        editVersion: 0,
        idempotencyKey: buildExportIdempotencyKey({ clipId: reserve.id, editVersion: 0 }),
        filename: "already-rendered.mp4",
      },
    });

    const outcome = await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
    });

    expect(outcome.promotedExportJobId).toBe(existing.id);
    expect(await prisma.exportJob.count({ where: { clipId: reserve.id } })).toBe(1);
  });
});

describe("when the sermon has nothing left", () => {
  it("still records the decision, empties the slot and opens an exception", async () => {
    const sermon = await createSermon("exhausted", []);

    const outcome = await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
      note: "Nothing usable here.",
    });

    expect(outcome.promotedClipId).toBeNull();
    expect(outcome.promotedExportJobId).toBeNull();
    expect(outcome.slotStatus).toBe(SchedulePublishStatus.UNFILLED);
    expect(outcome.editorialExceptionId).not.toBeNull();

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: sermon.slot.id } });
    // Both bindings cleared, so nothing downstream reads a rejected clip as current — and the
    // project link survives, which is what preserves ownership once the clip is gone.
    expect(slot.clipId).toBeNull();
    expect(slot.exportJobId).toBeNull();
    expect(slot.publishStatus).toBe(SchedulePublishStatus.UNFILLED);
    expect(slot.projectId).toBe(sermon.project.id);
    expect(slot.scheduledDate.toISOString()).toBe(sermon.slot.scheduledDate.toISOString());

    // The decision exists, with no replacement half filled in.
    const review = await prisma.clipReview.findUniqueOrThrow({ where: { id: outcome.clipReviewId } });
    expect(review.decision).toBe(ClipReviewDecision.REPLACE);
    expect(review.replacementClipIdSnapshot).toBeNull();
    expect(review.replacementExportJobIdSnapshot).toBeNull();

    const exception = await prisma.editorialException.findUniqueOrThrow({
      where: { id: outcome.editorialExceptionId as string },
    });
    expect(exception.exceptionType).toBe("reserve_pool_exhausted");
    expect(exception.state).toBe("OPEN");
    expect(exception.scheduledPostId).toBe(sermon.slot.id);
  });

  it("counts a pool of only ineligible clips as empty", async () => {
    const sermon = await createSermon("ineligible", []);
    await createClip(sermon.project.id, 2, GeneratedClipStatus.HIDDEN);
    await createClip(sermon.project.id, 3, GeneratedClipStatus.SUGGESTED);
    await createClip(sermon.project.id, 4, GeneratedClipStatus.SUPERSEDED);

    const outcome = await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
    });
    expect(outcome.promotedClipId).toBeNull();
    expect(outcome.slotStatus).toBe(SchedulePublishStatus.UNFILLED);
  });
});

describe("what a replacement refuses", () => {
  it("refuses a slot that is publishing, published or missed, and changes nothing", async () => {
    for (const status of [
      SchedulePublishStatus.IN_PROGRESS,
      SchedulePublishStatus.SUCCEEDED,
      SchedulePublishStatus.MISSED,
    ]) {
      const sermon = await createSermon(`state-${status}`, [3]);
      await prisma.scheduledPost.update({
        where: { id: sermon.slot.id },
        data: { publishStatus: status },
      });

      await expect(
        replaceScheduledClip(prisma, {
          scheduledPostId: sermon.slot.id,
          identity: sermon.identity,
          reviewerUserId: userId,
        }),
      ).rejects.toThrow(ReplacementRefusedError);

      // Nothing moved: no review, no supersession, no promotion.
      expect(
        await prisma.clipReview.count({ where: { scheduledPostIdSnapshot: sermon.slot.id } }),
      ).toBe(0);
      await expect(
        prisma.generatedClip.findUniqueOrThrow({ where: { id: sermon.scheduled.id } }),
      ).resolves.toMatchObject({ status: GeneratedClipStatus.KEPT });
      await expect(
        prisma.scheduledPost.findUniqueOrThrow({ where: { id: sermon.slot.id } }),
      ).resolves.toMatchObject({ clipId: sermon.scheduled.id });
    }
  });

  it("refuses a decision aimed at a file the slot no longer holds, and rolls everything back", async () => {
    const sermon = await createSermon("stale", [3]);

    await expect(
      replaceScheduledClip(prisma, {
        scheduledPostId: sermon.slot.id,
        identity: { ...sermon.identity, checksum: "sha256:something-else" },
        reviewerUserId: userId,
      }),
    ).rejects.toThrow(StaleRenderError);

    await expect(
      prisma.generatedClip.findUniqueOrThrow({ where: { id: sermon.scheduled.id } }),
    ).resolves.toMatchObject({ status: GeneratedClipStatus.KEPT });
    expect(await prisma.exportJob.count({ where: { clipId: sermon.reserves[0].id } })).toBe(0);
    expect(await prisma.clipReview.count({ where: { scheduledPostIdSnapshot: sermon.slot.id } })).toBe(0);
  });

  it("still refuses a bare REPLACE through the append path", async () => {
    const sermon = await createSermon("bare", [3]);
    await expect(
      appendClipReview(prisma, {
        scheduledPostId: sermon.slot.id,
        decision: ClipReviewDecision.REPLACE as never,
        identity: sermon.identity,
      }),
    ).rejects.toThrow(/cannot be appended on its own/);
  });
});

describe("two replacements at once", () => {
  it("gives them different reserves rather than both taking the best one", async () => {
    // Two slots in the same sermon, both reviewed at the same moment. Without the project lock
    // both would read the same candidate pool and choose rank 2.
    const project = await prisma.project.create({
      data: { workspaceId, sourceVideoId, name: `Concurrent ${Date.now()}` },
    });
    const first = await createClip(project.id, 1);
    const second = await createClip(project.id, 9);
    const reserveA = await createClip(project.id, 2);
    const reserveB = await createClip(project.id, 3);
    const exportA = await createBoundExport(first.id, "concurrent-a");
    const exportB = await createBoundExport(second.id, "concurrent-b");
    const slotA = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: first.id,
        exportJobId: exportA.id,
        scheduledDate: nextDate(),
      },
    });
    const slotB = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: second.id,
        exportJobId: exportB.id,
        scheduledDate: nextDate(),
      },
    });

    const [outcomeA, outcomeB] = await Promise.all([
      replaceScheduledClip(prisma, {
        scheduledPostId: slotA.id,
        identity: {
          clipId: first.id,
          exportJobId: exportA.id,
          editVersion: 1,
          checksum: exportA.qcChecksum as string,
        },
        reviewerUserId: userId,
      }),
      replaceScheduledClip(prisma, {
        scheduledPostId: slotB.id,
        identity: {
          clipId: second.id,
          exportJobId: exportB.id,
          editVersion: 1,
          checksum: exportB.qcChecksum as string,
        },
        reviewerUserId: userId,
      }),
    ]);

    const promoted = [outcomeA.promotedClipId, outcomeB.promotedClipId];
    expect(new Set(promoted).size).toBe(2);
    expect(promoted).toContain(reserveA.id);
    expect(promoted).toContain(reserveB.id);
  });
});

describe("the priority a replacement's render carries", () => {
  it("reaches a worker ahead of older ordinary work", async () => {
    const sermon = await createSermon("priority", [3]);

    // `claimNextExportJob` takes the globally best job, not this test's. Earlier tests in this
    // file leave priority renders queued, so without clearing them the claim below would hand
    // back one of those and the assertion would pass or fail for reasons unrelated to ordering.
    await prisma.exportJob.updateMany({
      where: { state: { in: [ProcessingJobState.QUEUED, ProcessingJobState.RETRYING] } },
      data: { state: ProcessingJobState.SUCCEEDED },
    });

    // Ordinary work queued first, so oldest-first alone would hand this one out.
    const ordinary = await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: sermon.reserves[0].id,
        idempotencyKey: `ordinary-${Date.now()}`,
        filename: "ordinary.mp4",
        editVersion: 99,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const outcome = await replaceScheduledClip(prisma, {
      scheduledPostId: sermon.slot.id,
      identity: sermon.identity,
      reviewerUserId: userId,
    });

    const claimed = await claimNextExportJob(prisma);
    expect(claimed?.id).toBe(outcome.promotedExportJobId);
    expect(claimed?.id).not.toBe(ordinary.id);
  });
});
