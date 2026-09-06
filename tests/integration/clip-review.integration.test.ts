import {
  AuthProvider,
  ClipReviewDecision,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
  ReviewFeedbackSeverity,
  ReviewerKind,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessReanalysis, countDurableWork } from "@/lib/analysis/reanalysis-policy";
import {
  appendClipReview,
  appendReviewFeedback,
  latestReviewForRender,
  latestReviewForSlot,
  reviewHistoryForSlot,
} from "@/lib/review/service";
import { loadReviewSubject } from "@/lib/review/snapshots";
import {
  BareReplaceForbiddenError,
  NotRevisableError,
  ReviewSubjectError,
  StaleRenderError,
} from "@/lib/review/types";

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2037, 0, serial));
}

/** A slot with a clip and a QC-passed export bound to it: the only reviewable shape. */
async function createReviewableSlot(label: string, options?: { editVersion?: number }) {
  serial += 1;
  const project = await prisma.project.create({
    data: { workspaceId, name: `Review ${label} ${serial}` },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: serial,
      startMs: 10_000,
      endMs: 70_000,
      title: `Review ${label}`,
      hookText: "A hook under review.",
      summary: "Review fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  const exportJob = await prisma.exportJob.create({
    data: {
      workspaceId,
      clipId: clip.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `review-${label}-${serial}`,
      filename: `${label}.mp4`,
      editVersion: options?.editVersion ?? 2,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: `sha256:${label}-${serial}`,
    },
  });
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId: project.id,
      clipId: clip.id,
      exportJobId: exportJob.id,
      scheduledDate: nextDate(),
    },
  });
  return {
    project,
    clip,
    exportJob,
    slot,
    identity: {
      clipId: clip.id,
      exportJobId: exportJob.id,
      editVersion: exportJob.editVersion as number,
      checksum: exportJob.qcChecksum as string,
    },
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `clip-review-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Clip review tests" },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("appending a decision", () => {
  it("records an ACCEPT against the exact file, with its identity and snapshots", async () => {
    const fixture = await createReviewableSlot("accept");

    const review = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
      note: "Lands cleanly.",
    });

    expect(review.decision).toBe(ClipReviewDecision.ACCEPT);
    expect(review.reviewerKind).toBe(ReviewerKind.HUMAN);
    expect(review.clipIdSnapshot).toBe(fixture.clip.id);
    expect(review.exportJobIdSnapshot).toBe(fixture.exportJob.id);
    expect(review.editVersion).toBe(2);
    expect(review.checksum).toBe(fixture.identity.checksum);
    expect(review.clipRank).toBe(fixture.clip.rank);
    expect(review.clipStartMs).toBe(10_000);
    expect(review.clipEndMs).toBe(70_000);
    // Context for replay and the UI, never an eligibility input.
    expect(review.slotSnapshot).toMatchObject({
      platform: "FACEBOOK",
      title: fixture.clip.title,
      hookText: "A hook under review.",
      qcStatus: RenderQcStatus.PASSED,
    });
  });

  it("writes several findings with the decision, and derives their actionability", async () => {
    const fixture = await createReviewableSlot("revise");

    const review = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.REVISE,
      identity: fixture.identity,
      reviewerUserId: userId,
      feedback: [
        { category: ReviewFeedbackCategory.BOUNDARY, note: "Starts a sentence early.", startMs: 0, endMs: 1_500 },
        {
          category: ReviewFeedbackCategory.CAPTION,
          note: "Caption over the chin.",
          severity: ReviewFeedbackSeverity.MINOR,
        },
        // At the very start, so a trim can remove it and leave one continuous range.
        {
          category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
          note: "Tail of the previous slide.",
          startMs: 0,
          endMs: 900,
        },
      ],
    });

    expect(review.feedback).toHaveLength(3);
    expect(review.feedback.every((row) => row.actionability === ReviewFeedbackActionability.REVISABLE)).toBe(
      true,
    );
    expect(review.feedback.every((row) => row.workspaceId === workspaceId)).toBe(true);
    // The reviewer authored the decision, so they author its findings unless told otherwise.
    expect(review.feedback.every((row) => row.authorUserId === userId)).toBe(true);
    expect(review.feedback.find((row) => row.category === ReviewFeedbackCategory.CAPTION)?.severity).toBe(
      ReviewFeedbackSeverity.MINOR,
    );
  });

  it("refuses a REVISE carrying a finding that re-editing cannot fix", async () => {
    const fixture = await createReviewableSlot("not-revisable");

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        decision: ClipReviewDecision.REVISE,
        identity: fixture.identity,
        feedback: [
          { category: ReviewFeedbackCategory.CAPTION, note: "Fixable." },
          { category: ReviewFeedbackCategory.CONTENT, note: "The point never lands." },
        ],
      }),
    ).rejects.toThrow(NotRevisableError);

    // Nothing was written: a refused decision leaves no half-review behind.
    expect(await prisma.clipReview.count({ where: { scheduledPostIdSnapshot: fixture.slot.id } })).toBe(0);
  });

  it("refuses a REVISE for forbidden content sitting mid-clip", async () => {
    const fixture = await createReviewableSlot("mid-clip-forbidden");

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        decision: ClipReviewDecision.REVISE,
        identity: fixture.identity,
        feedback: [
          {
            category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
            note: "Mid-clip slide.",
            startMs: 20_000,
            endMs: 24_000,
          },
        ],
      }),
    ).rejects.toThrow(NotRevisableError);
  });

  it("refuses a bare REPLACE, because a replacement is five writes and not a verdict", async () => {
    const fixture = await createReviewableSlot("bare-replace");

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        // Only P2.7's atomic command may create one. The cast is what a form or a script would
        // hand this function, so the guard has to hold at runtime and not only in the types.
        decision: ClipReviewDecision.REPLACE as never,
        identity: fixture.identity,
      }),
    ).rejects.toThrow(BareReplaceForbiddenError);

    expect(await prisma.clipReview.count({ where: { scheduledPostIdSnapshot: fixture.slot.id } })).toBe(0);
  });
});

describe("the exact-render requirement", () => {
  it("refuses a decision aimed at a file the slot no longer holds", async () => {
    const fixture = await createReviewableSlot("stale");
    const staleIdentity = { ...fixture.identity, editVersion: 1 };

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        decision: ClipReviewDecision.ACCEPT,
        identity: staleIdentity,
      }),
    ).rejects.toThrow(StaleRenderError);
  });

  it("refuses a slot with no bound export, and one whose export never passed QC", async () => {
    const bare = await createReviewableSlot("bare-slot");
    await prisma.scheduledPost.update({
      where: { id: bare.slot.id },
      data: { exportJobId: null },
    });
    await expect(loadReviewSubject(prisma, bare.slot.id)).rejects.toThrow(/no export bound/);

    const unchecked = await createReviewableSlot("no-qc");
    await prisma.exportJob.update({
      where: { id: unchecked.exportJob.id },
      data: { qcChecksum: null },
    });
    await expect(loadReviewSubject(prisma, unchecked.slot.id)).rejects.toThrow(/no QC checksum/);
  });

  it("refuses a historical export that does not name its edit version", async () => {
    const legacy = await createReviewableSlot("legacy");
    await prisma.exportJob.update({
      where: { id: legacy.exportJob.id },
      data: { editVersion: null },
    });
    await expect(loadReviewSubject(prisma, legacy.slot.id)).rejects.toThrow(
      /does not name the edit version/,
    );
  });

  it("refuses a finding placed outside the clip it is about", async () => {
    const fixture = await createReviewableSlot("bad-span");

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        decision: ClipReviewDecision.REVISE,
        identity: fixture.identity,
        // The clip is 60s long; 90s is not inside it.
        feedback: [{ category: ReviewFeedbackCategory.CAPTION, note: "n", startMs: 90_000, endMs: 91_000 }],
      }),
    ).rejects.toThrow(ReviewSubjectError);

    await expect(
      appendClipReview(prisma, {
        scheduledPostId: fixture.slot.id,
        decision: ClipReviewDecision.REVISE,
        identity: fixture.identity,
        feedback: [{ category: ReviewFeedbackCategory.CAPTION, note: "n", startMs: 100 }],
      }),
    ).rejects.toThrow(/both a start and an end/);
  });
});

describe("correction by supersession", () => {
  it("cannot edit a decision, and reads the newest one as the verdict", async () => {
    const fixture = await createReviewableSlot("supersede");

    const first = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
      note: "Looked fine.",
    });

    // The database refuses the update outright, so the service offers no path to one.
    await expect(
      prisma.clipReview.update({
        where: { id: first.id },
        data: { decision: ClipReviewDecision.REVISE },
      }),
    ).rejects.toThrow(/append-only/);

    const second = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.REVISE,
      identity: fixture.identity,
      reviewerUserId: userId,
      note: "Watched again; the caption is wrong.",
      feedback: [{ category: ReviewFeedbackCategory.CAPTION, note: "Overlaps the lower third." }],
    });

    const latest = await latestReviewForSlot(prisma, fixture.slot.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.decision).toBe(ClipReviewDecision.REVISE);

    // The older decision is still readable beside it. That is the audit trail.
    const history = await reviewHistoryForSlot(prisma, fixture.slot.id);
    expect(history.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(history[0].note).toBe("Looked fine.");
  });

  it("finds the standing decision for one exact render, not merely for the export id", async () => {
    const fixture = await createReviewableSlot("by-render");
    await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
    });

    await expect(latestReviewForRender(prisma, fixture.identity)).resolves.toMatchObject({
      decision: ClipReviewDecision.ACCEPT,
    });
    // A rebuild of the same export produces different bytes. The acceptance must not survive it.
    await expect(
      latestReviewForRender(prisma, { ...fixture.identity, checksum: "sha256:rebuilt" }),
    ).resolves.toBeNull();
    await expect(
      latestReviewForRender(prisma, { ...fixture.identity, editVersion: 99 }),
    ).resolves.toBeNull();
  });
});

describe("feedback appended later", () => {
  it("takes more findings after the decision, without a practical limit", async () => {
    const fixture = await createReviewableSlot("more-feedback");
    const review = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
      feedback: [{ category: ReviewFeedbackCategory.CAPTION, note: "First thought." }],
    });

    const later = await appendReviewFeedback(prisma, {
      clipReviewId: review.id,
      feedback: Array.from({ length: 40 }, (_, index) => ({
        category: ReviewFeedbackCategory.TITLE_HOOK,
        note: `Later thought ${index}`,
      })),
    });
    expect(later).toHaveLength(41);

    // The decision itself did not move. Changing it means appending a new review.
    const latest = await latestReviewForSlot(prisma, fixture.slot.id);
    expect(latest?.id).toBe(review.id);
    expect(latest?.decision).toBe(ClipReviewDecision.ACCEPT);
    expect(latest?.feedback).toHaveLength(41);
  });

  it("places a late finding against the clip that was reviewed, after that clip is gone", async () => {
    const fixture = await createReviewableSlot("late-after-deletion");
    const review = await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
    });

    await prisma.generatedClip.delete({ where: { id: fixture.clip.id } });

    // The span comes from the review's own snapshot, so the finding is still placed correctly.
    const added = await appendReviewFeedback(prisma, {
      clipReviewId: review.id,
      feedback: [
        {
          category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
          note: "Noticed on a rewatch.",
          startMs: 30_000,
          endMs: 31_000,
        },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0].actionability).toBe(ReviewFeedbackActionability.REPLACE_ONLY);

    const retained = await prisma.clipReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(retained.clipId).toBeNull();
    expect(retained.clipIdSnapshot).toBe(fixture.clip.id);
    expect(retained.clipStartMs).toBe(10_000);
  });
});

describe("reanalysis after a review", () => {
  it("is blocked by a decision alone, counted from the immutable snapshot", async () => {
    const fixture = await createReviewableSlot("reanalysis");

    const before = await countDurableWork(prisma, { projectId: fixture.project.id });
    expect(before.reviews).toBe(0);

    await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: userId,
    });

    const after = await countDurableWork(prisma, { projectId: fixture.project.id });
    expect(after.reviews).toBe(1);
    await expect(assessReanalysis(prisma, { projectId: fixture.project.id })).resolves.toMatchObject(
      { allowed: false },
    );

    // Still counted after the clip and its export are destroyed, because the snapshot survives.
    await prisma.generatedClip.delete({ where: { id: fixture.clip.id } });
    const afterDeletion = await countDurableWork(prisma, { projectId: fixture.project.id });
    expect(afterDeletion.reviews).toBe(1);
    expect(afterDeletion.exports).toBe(0);
  });
});
