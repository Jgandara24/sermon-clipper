import {
  AuthProvider,
  EditorialExceptionState,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  ProjectStatus,
  PublishAttemptState,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
  SchedulePublishStatus,
  SourceOrigin,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "@/lib/analysis/clip-status";
import { claimNextExportJob } from "@/lib/exports/queue";
import {
  applyPriorServiceFill,
  PriorServiceFillRefusedError,
  PRIOR_SERVICE_FILL_EXPORT_PRIORITY,
} from "@/lib/review/prior-service-fill";
import { SOURCE_RETENTION_TAIL_DAYS } from "@/lib/retention";

/**
 * Filling an empty date from an older sermon, against real rows.
 *
 * The races are the substance. Everything else in this command is a conditional write; the part
 * that only a database can prove is that the source-video lock actually serialises this against
 * cleanup, and that two operators cannot both take the same clip or the same date.
 */

const prisma = new PrismaClient();
let operatorId: string;
let workspaceId: string;
let serial = 0;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

function nextDate(offsetDays: number) {
  serial += 1;
  return new Date(Date.UTC(2050, 0, serial + offsetDays));
}

async function createService(
  label: string,
  options: { serviceAt: Date; status?: ProjectStatus; withSource?: boolean } = {
    serviceAt: nextDate(0),
  },
) {
  const source = (options.withSource ?? true)
    ? await prisma.sourceVideo.create({
        data: {
          workspaceId,
          origin: SourceOrigin.UPLOAD,
          filename: `${label}.mp4`,
          storageKey: `src/${workspaceId}/${uniqueKey(label)}.mp4`,
        },
      })
    : null;

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: `Fill ${label}`,
      sourceVideoId: source?.id ?? null,
      status: options.status ?? ProjectStatus.READY,
      sermonDate: options.serviceAt,
    },
  });
  return { project, source };
}

async function createCandidate(projectId: string, rank: number) {
  serial += 1;
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank,
      startMs: rank * 60_000,
      endMs: rank * 60_000 + 40_000,
      title: `Borrowable ${rank}`,
      summary: "Prior-service fixture.",
      status: ANALYSIS_RETAINED_CLIP_STATUS,
    },
  });
  await prisma.clipEdit.create({
    data: { clipId: clip.id, version: 1, editorState: {}, savedBy: null },
  });
  return clip;
}

/** An empty date, exactly as P2.7 leaves one when a sermon runs out of reserves. */
async function createEmptySlot(projectId: string, scheduledDate = nextDate(30)) {
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId,
      clipId: null,
      scheduledDate,
      publishStatus: SchedulePublishStatus.UNFILLED,
    },
  });
  const exception = await prisma.editorialException.create({
    data: {
      workspaceId,
      projectId,
      scheduledPostId: slot.id,
      exceptionType: "reserve_pool_exhausted",
      state: EditorialExceptionState.OPEN,
      message: "This date has nothing to post.",
      slotSnapshot: { scheduledDate: scheduledDate.toISOString() },
    },
  });
  return { slot, exception };
}

/** A target service, an older service, one borrowable clip, and one empty date. */
async function scenario(label: string) {
  const older = await createService(`${label}-older`, { serviceAt: new Date(Date.UTC(2050, 0, 1)) });
  const target = await createService(`${label}-target`, {
    serviceAt: new Date(Date.UTC(2050, 5, 1)),
  });
  const candidate = await createCandidate(older.project.id, 1);
  const { slot, exception } = await createEmptySlot(target.project.id);
  return { older, target, candidate, slot, exception };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("fill-op")}@example.com`,
      authProvider: AuthProvider.DEV,
      isPlatformOperator: true,
    },
  });
  operatorId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Prior service fill tests" },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (operatorId) await prisma.user.delete({ where: { id: operatorId } });
  await prisma.$disconnect();
});

describe("one fill, all at once", () => {
  it("binds the clip and a priority render, keeps the date, and resolves the exception", async () => {
    const s = await scenario("happy");

    const outcome = await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    expect(outcome).toMatchObject({
      filledClipId: s.candidate.id,
      slotStatus: SchedulePublishStatus.NOT_STARTED,
      targetProjectId: s.target.project.id,
      sourceProjectId: s.older.project.id,
      alreadyFilled: false,
    });

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.clipId).toBe(s.candidate.id);
    expect(slot.exportJobId).toBe(outcome.exportJobId);
    expect(slot.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);
    // A fill changes what goes out, never whose service owns the date, when, or where.
    expect(slot.projectId).toBe(s.target.project.id);
    expect(slot.scheduledDate.toISOString()).toBe(s.slot.scheduledDate.toISOString());
    expect(slot.platform).toBe(s.slot.platform);

    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: outcome.exportJobId } });
    expect(job.priority).toBe(PRIOR_SERVICE_FILL_EXPORT_PRIORITY);
    // Pinned to the cut that exists now, not to whatever a worker later finds.
    expect(job.editVersion).toBe(1);
    expect(job.clipId).toBe(s.candidate.id);

    // Resolved in place: the evidence of the shortage survives its resolution.
    const exception = await prisma.editorialException.findUniqueOrThrow({
      where: { id: s.exception.id },
    });
    expect(exception.state).toBe(EditorialExceptionState.RESOLVED);
    expect(exception.resolvedByUserId).toBe(operatorId);
    expect(exception.message).toBe("This date has nothing to post.");
    expect(outcome.resolvedExceptionIds).toEqual([s.exception.id]);
  });

  it("writes no REPLACE decision, because the earlier one still stands", async () => {
    const s = await scenario("no-replace");
    const before = await prisma.clipReview.count({ where: { workspaceId } });

    await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    expect(await prisma.clipReview.count({ where: { workspaceId } })).toBe(before);
  });

  it("extends the borrowed sermon's retention past its new posting date", async () => {
    const s = await scenario("retention");
    // Expiring long before the date it is about to be posted on.
    await prisma.project.update({
      where: { id: s.older.project.id },
      data: { expiresAt: new Date(Date.UTC(2050, 0, 2)) },
    });

    await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    const older = await prisma.project.findUniqueOrThrow({ where: { id: s.older.project.id } });
    const tail = new Date(s.slot.scheduledDate);
    tail.setUTCDate(tail.getUTCDate() + SOURCE_RETENTION_TAIL_DAYS);
    expect(older.expiresAt).not.toBeNull();
    expect(older.expiresAt!.getTime()).toBeGreaterThanOrEqual(tail.getTime());
  });

  it("records both services, because two are involved", async () => {
    const s = await scenario("audit");
    await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    const event = await prisma.operationalEvent.findFirstOrThrow({
      where: { workspaceId, eventType: "prior_service_fill_applied" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({
      targetProjectId: s.target.project.id,
      sourceProjectId: s.older.project.id,
      operatorUserId: operatorId,
    });
  });

  it("reaches a worker ahead of ordinary work", async () => {
    const s = await scenario("priority");
    // Ordinary work, queued first and therefore older.
    const ordinary = await createCandidate(s.older.project.id, 9);
    await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: ordinary.id,
        state: ProcessingJobState.QUEUED,
        idempotencyKey: uniqueKey("ordinary"),
        filename: "ordinary.mp4",
        editVersion: 1,
      },
    });

    const outcome = await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    // Scoped by claiming until this test's own job appears, because `claimNextExportJob` takes
    // the globally best row and other files leave work behind.
    const claimedIds: string[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const claimed = await claimNextExportJob(prisma);
      if (!claimed) break;
      claimedIds.push(claimed.id);
      if (claimed.id === outcome.exportJobId) break;
    }
    expect(claimedIds).toContain(outcome.exportJobId);
    // The priority render came before this test's ordinary one, whatever else was in the queue.
    expect(claimedIds.indexOf(outcome.exportJobId)).toBeLessThan(
      claimedIds.includes(ordinary.id) ? claimedIds.indexOf(ordinary.id) : Number.MAX_SAFE_INTEGER,
    );
  });

  it("is idempotent: a second click returns the same answer", async () => {
    const s = await scenario("retry");
    const first = await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });
    const second = await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    expect(second.exportJobId).toBe(first.exportJobId);
    expect(second.filledClipId).toBe(first.filledClipId);
    expect(second.alreadyFilled).toBe(true);
    expect(await prisma.exportJob.count({ where: { clipId: s.candidate.id } })).toBe(1);
  });
});

describe("what a fill refuses", () => {
  it("refuses a clip from another church", async () => {
    const s = await scenario("tenant");
    const otherUser = await prisma.user.create({
      data: { email: `${uniqueKey("other")}@example.com`, authProvider: AuthProvider.DEV },
    });
    const otherWorkspace = await prisma.workspace.create({
      data: { ownerId: otherUser.id, name: "Another church" },
    });
    try {
      const foreignProject = await prisma.project.create({
        data: {
          workspaceId: otherWorkspace.id,
          name: "Foreign service",
          status: ProjectStatus.READY,
          sermonDate: new Date(Date.UTC(2050, 0, 1)),
        },
      });
      const foreignClip = await prisma.generatedClip.create({
        data: {
          workspaceId: otherWorkspace.id,
          projectId: foreignProject.id,
          rank: 1,
          startMs: 0,
          endMs: 30_000,
          title: "Foreign clip",
          summary: "Belongs elsewhere.",
          status: ANALYSIS_RETAINED_CLIP_STATUS,
        },
      });

      await expect(
        applyPriorServiceFill(prisma, {
          scheduledPostId: s.slot.id,
          candidateClipId: foreignClip.id,
          operatorUserId: operatorId,
        }),
      ).rejects.toMatchObject({ reason: "candidate_workspace_mismatch" });
    } finally {
      await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
      await prisma.user.delete({ where: { id: otherUser.id } });
    }
  });

  it("refuses a date that already published, and changes nothing", async () => {
    const s = await scenario("published");
    await prisma.scheduledPost.update({
      where: { id: s.slot.id },
      data: { publishStatus: SchedulePublishStatus.SUCCEEDED, facebookPostId: "fb-1" },
    });

    await expect(
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "slot_state_not_fillable" });

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.clipId).toBeNull();
    expect(await prisma.exportJob.count({ where: { clipId: s.candidate.id } })).toBe(0);
  });

  /**
   * P1.12 writes the publish intent before the provider call, so a claim can outlive a process
   * that died mid-publish. Filling that date would hand a second clip to a post that may exist.
   */
  it("refuses a date with an outstanding publish claim", async () => {
    const s = await scenario("claimed");
    await prisma.publishAttempt.create({
      data: { scheduledPostId: s.slot.id, state: PublishAttemptState.INDETERMINATE },
    });

    await expect(
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "slot_publish_claimed" });
  });

  it("refuses a clip a reviewer marked as forbidden", async () => {
    const s = await scenario("forbidden");
    const review = await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: s.older.project.id,
        scheduledPostIdSnapshot: s.slot.id,
        clipIdSnapshot: s.candidate.id,
        clipRank: 1,
        clipStartMs: 60_000,
        clipEndMs: 100_000,
        exportJobIdSnapshot: s.slot.id,
        editVersion: 1,
        checksum: "sha256:whatever",
        decision: "REVISE",
      },
    });
    await prisma.clipReviewFeedback.create({
      data: {
        clipReviewId: review.id,
        workspaceId,
        category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
        actionability: ReviewFeedbackActionability.REPLACE_ONLY,
        note: "A slide with a private phone number is on screen.",
      },
    });

    await expect(
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "candidate_forbidden" });
  });

  /**
   * A form rendered while the date was empty, submitted after somebody else filled it.
   *
   * The refusal is `slot_state_not_fillable` rather than `SLOT_MOVED`, because the policy runs
   * before the conditional claim and a filled date is already `NOT_STARTED` by then. `SLOT_MOVED`
   * covers the narrower window *inside* the transaction — between the policy passing and the
   * claim landing — which only a genuine race can open, and which the concurrency cases below
   * exercise. Both guards are wanted; this is the one an operator actually meets.
   */
  it("refuses a stale form whose date somebody else already filled", async () => {
    const s = await scenario("stale");
    const rival = await createCandidate(s.older.project.id, 4);
    await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: rival.id,
      operatorUserId: operatorId,
    });

    // The operator's form still names the clip they were looking at.
    await expect(
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "slot_state_not_fillable" });

    // And the date still holds what the winner put there.
    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.clipId).toBe(rival.id);
  });
});

describe("the race with source cleanup", () => {
  /**
   * Cleanup won. The key is already null by the time the fill re-reads it under the lock, and the
   * fill refuses before writing anything. Extending retention would not have helped: retention
   * decides when media goes, not whether media that has gone can come back.
   */
  it("refuses once the recording is gone, and leaves the date empty", async () => {
    const s = await scenario("purged");
    await prisma.sourceVideo.update({
      where: { id: s.older.source!.id },
      data: { storageKey: null },
    });

    await expect(
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "source_not_renderable" });

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.clipId).toBeNull();
    expect(slot.publishStatus).toBe(SchedulePublishStatus.UNFILLED);
    expect(await prisma.exportJob.count({ where: { clipId: s.candidate.id } })).toBe(0);
    // And the exception stays open, because the shortage was not resolved.
    const exception = await prisma.editorialException.findUniqueOrThrow({
      where: { id: s.exception.id },
    });
    expect(exception.state).toBe(EditorialExceptionState.OPEN);
  });

  /**
   * The fill won. Retention has been pushed past the new posting date inside the same
   * transaction, so a cleanup sweep re-reading the expiry now finds a later one and keeps the
   * source — which is the whole point of taking the lock rather than merely checking the key.
   */
  it("extends retention so a later cleanup sweep keeps the recording", async () => {
    const s = await scenario("fill-wins");
    await prisma.project.update({
      where: { id: s.older.project.id },
      data: { expiresAt: new Date(Date.UTC(2050, 0, 2)) },
    });

    await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    // What cleanup asks: are every project on this source expired by now?
    const projects = await prisma.project.findMany({
      where: { sourceVideoId: s.older.source!.id },
      select: { expiresAt: true },
    });
    const { shouldPurgeSourceMedia } = await import("@/lib/retention");
    expect(shouldPurgeSourceMedia(projects, s.slot.scheduledDate)).toBe(false);
  });

  it("gives one clip to one date when two operators want it at once", async () => {
    const s = await scenario("same-candidate");
    const secondSlot = await createEmptySlot(s.target.project.id);

    const results = await Promise.allSettled([
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
      applyPriorServiceFill(prisma, {
        scheduledPostId: secondSlot.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The loser is told why rather than crashing on the unique index.
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PriorServiceFillRefusedError);
    expect(await prisma.scheduledPost.count({ where: { clipId: s.candidate.id } })).toBe(1);
  });

  it("gives one date to one clip when two candidates are offered at once", async () => {
    const s = await scenario("same-slot");
    const rival = await createCandidate(s.older.project.id, 7);

    const results = await Promise.allSettled([
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: s.candidate.id,
        operatorUserId: operatorId,
      }),
      applyPriorServiceFill(prisma, {
        scheduledPostId: s.slot.id,
        candidateClipId: rival.id,
        operatorUserId: operatorId,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect([s.candidate.id, rival.id]).toContain(slot.clipId);
  });
});

describe("after the fill", () => {
  /**
   * A render that fails after the commit leaves the date bound and unpublishable, which is the
   * correct end state: P2.8 requires a human `ACCEPT` of an exact file, and there is no file.
   * Nothing reaches for another candidate — the operator chose this one, and choosing again is
   * theirs to do.
   */
  it("stays blocked when the render fails, and picks nobody else", async () => {
    const s = await scenario("render-fails");
    const outcome = await applyPriorServiceFill(prisma, {
      scheduledPostId: s.slot.id,
      candidateClipId: s.candidate.id,
      operatorUserId: operatorId,
    });

    await prisma.exportJob.update({
      where: { id: outcome.exportJobId },
      data: { state: ProcessingJobState.FAILED, errorCode: "RENDER_FAILED" },
    });

    const { assessScheduledPostDelivery } = await import("@/lib/delivery/query");
    await expect(
      assessScheduledPostDelivery(prisma, { scheduledPostId: s.slot.id }),
    ).resolves.toMatchObject({ eligible: false });

    // Still this clip, still this date. No second candidate was selected.
    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.clipId).toBe(s.candidate.id);
    expect(slot.exportJobId).toBe(outcome.exportJobId);
  });
});
