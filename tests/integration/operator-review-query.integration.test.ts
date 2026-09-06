import {
  AuthProvider,
  ClipReviewDecision,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySignedMediaUrl } from "@/lib/media/signed-url";
import { listOperatorReviewQueue, loadOperatorReviewDetail } from "@/lib/review/query";
import { appendClipReview } from "@/lib/review/service";

const prisma = new PrismaClient();
const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let reviewerId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2039, 0, serial));
}

async function createChurch(name: string) {
  serial += 1;
  const owner = await prisma.user.create({
    data: { email: `church-${serial}-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  createdUserIds.push(owner.id);
  const workspace = await prisma.workspace.create({ data: { ownerId: owner.id, name } });
  createdWorkspaceIds.push(workspace.id);
  return workspace;
}

/** A slot with a clip, a QC-passed render, and a stored output file: the reviewable shape. */
async function createReviewableSlot(
  workspaceId: string,
  label: string,
  options?: { withOutput?: boolean; qcStatus?: RenderQcStatus; state?: ProcessingJobState },
) {
  serial += 1;
  const project = await prisma.project.create({
    data: { workspaceId, name: `Queue ${label} ${serial}` },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: serial,
      startMs: 30_000,
      endMs: 90_000,
      title: `Title for ${label}`,
      hookText: `Hook for ${label}`,
      summary: "Queue fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  // The selector's score exists on the row and must never reach the operator's page.
  await prisma.clipScore.create({
    data: {
      workspaceId,
      clipId: clip.id,
      total: 87,
      subscores: { hook: 5, clarity: 4 },
      modelVersion: "selector-v1",
      excerpt: "The machine's reason for choosing this clip.",
    },
  });

  const outputFile = options?.withOutput === false
    ? null
    : await prisma.exportedFile.create({
        data: {
          storageKey: `${workspaceId}/exports/${label}-${serial}.mp4`,
          bytes: BigInt(1024),
          width: 1080,
          height: 1920,
          checksum: `sha256:${label}-${serial}`,
          downloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

  const exportJob = await prisma.exportJob.create({
    data: {
      workspaceId,
      clipId: clip.id,
      state: options?.state ?? ProcessingJobState.SUCCEEDED,
      idempotencyKey: `queue-${label}-${serial}`,
      filename: `${label}.mp4`,
      editVersion: 3,
      qcStatus: options?.qcStatus ?? RenderQcStatus.PASSED,
      qcCheckedAt: new Date(),
      qcChecksum: `sha256:${label}-${serial}`,
      qcDetails: { version: 1, checks: [{ name: "bytes", passed: true, detail: "1024 bytes" }] },
      outputFileId: outputFile?.id,
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
    outputFile,
    slot,
    identity: {
      clipId: clip.id,
      exportJobId: exportJob.id,
      editVersion: 3,
      checksum: exportJob.qcChecksum as string,
    },
  };
}

beforeAll(async () => {
  const reviewer = await prisma.user.create({
    data: {
      email: `operator-query-${Date.now()}@example.com`,
      authProvider: AuthProvider.DEV,
      isPlatformOperator: true,
    },
  });
  reviewerId = reviewer.id;
  createdUserIds.push(reviewer.id);
});

afterAll(async () => {
  await prisma.publishAttempt.deleteMany({
    where: { scheduledPost: { workspaceId: { in: createdWorkspaceIds } } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("the cross-workspace queue", () => {
  it("lists slots from more than one church in one call", async () => {
    const first = await createChurch("First Baptist Queue");
    const second = await createChurch("Second Baptist Queue");
    const a = await createReviewableSlot(first.id, "church-a");
    const b = await createReviewableSlot(second.id, "church-b");

    const rows = await listOperatorReviewQueue(prisma);
    const ids = rows.map((row) => row.scheduledPostId);
    expect(ids).toContain(a.slot.id);
    expect(ids).toContain(b.slot.id);

    const rowA = rows.find((row) => row.scheduledPostId === a.slot.id);
    expect(rowA).toMatchObject({
      churchName: "First Baptist Queue",
      clipTitle: a.clip.title,
      renderState: ProcessingJobState.SUCCEEDED,
      qcStatus: RenderQcStatus.PASSED,
      latestDecision: null,
      latestDecisionIsCurrent: false,
      clipDurationMs: 60_000,
    });
  });

  it("carries no selector signal at all", async () => {
    const church = await createChurch("No Selector Queue");
    await createReviewableSlot(church.id, "no-selector");

    const rows = await listOperatorReviewQueue(prisma);
    // The score row exists — the fixture creates one — and none of it is here.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("subscores");
    expect(serialised).not.toContain("selector-v1");
    expect(serialised).not.toContain("The machine's reason");

    // Stronger than searching for the score's value, which would be a two-digit number hunted
    // through a blob full of UUIDs — "87" duly turned up inside one. The row's shape is fixed
    // instead, so a field nobody chose cannot appear at all.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "churchName",
        "clipDurationMs",
        "clipTitle",
        "latestDecision",
        "latestDecisionAt",
        "latestDecisionIsCurrent",
        "platform",
        "projectName",
        "publishStatus",
        "qcStatus",
        "renderState",
        "scheduledDate",
        "scheduledPostId",
        "workspaceId",
      ].sort(),
    );
  });

  it("leaves out published and missed slots, which are finished business", async () => {
    const church = await createChurch("Finished Queue");
    const done = await createReviewableSlot(church.id, "done");
    await prisma.scheduledPost.update({
      where: { id: done.slot.id },
      data: { publishStatus: SchedulePublishStatus.SUCCEEDED },
    });

    const rows = await listOperatorReviewQueue(prisma);
    expect(rows.map((row) => row.scheduledPostId)).not.toContain(done.slot.id);
  });

  it("marks a decision made about an earlier file as not current", async () => {
    const church = await createChurch("Stale Queue");
    const fixture = await createReviewableSlot(church.id, "stale");
    await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: reviewerId,
    });

    const before = (await listOperatorReviewQueue(prisma)).find(
      (row) => row.scheduledPostId === fixture.slot.id,
    );
    expect(before).toMatchObject({
      latestDecision: ClipReviewDecision.ACCEPT,
      latestDecisionIsCurrent: true,
    });

    // A rerender of the same edit produces different bytes. The acceptance must stop counting.
    await prisma.exportJob.update({
      where: { id: fixture.exportJob.id },
      data: { qcChecksum: "sha256:rebuilt" },
    });

    const after = (await listOperatorReviewQueue(prisma)).find(
      (row) => row.scheduledPostId === fixture.slot.id,
    );
    expect(after).toMatchObject({
      latestDecision: ClipReviewDecision.ACCEPT,
      latestDecisionIsCurrent: false,
    });
  });
});

describe("the detail page's model", () => {
  it("signs the exact bound file for the church that owns it, not for the operator", async () => {
    const church = await createChurch("Signed Detail");
    const other = await createChurch("Other Church");
    const fixture = await createReviewableSlot(church.id, "signed");

    const detail = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    expect(detail?.playbackUrl).toBeTruthy();

    const verified = verifySignedMediaUrl(
      new URL(detail!.playbackUrl!, "http://x").searchParams,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    // The church's id, which is what the media route checks the key against.
    expect(verified.workspaceId).toBe(church.id);
    expect(verified.workspaceId).not.toBe(other.id);
    expect(verified.key).toBe(fixture.outputFile?.storageKey);
    expect(verified.contentType).toBe("video/mp4");
  });

  it("shows the four identity facts, the title, the hook and the QC result", async () => {
    const church = await createChurch("Identity Detail");
    const fixture = await createReviewableSlot(church.id, "identity");

    const detail = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    expect(detail?.identity).toEqual({
      clipId: fixture.clip.id,
      exportJobId: fixture.exportJob.id,
      editVersion: 3,
      checksum: fixture.exportJob.qcChecksum,
    });
    // Machine-generated, and under review, so they are shown.
    expect(detail?.clipTitle).toBe(fixture.clip.title);
    expect(detail?.clipHook).toBe(fixture.clip.hookText);
    expect(detail?.qcStatus).toBe(RenderQcStatus.PASSED);
    expect(detail?.qcCheckedAt).toBeTruthy();
  });

  it("carries no selector signal, with a score row sitting right beside the clip", async () => {
    const church = await createChurch("No Selector Detail");
    const fixture = await createReviewableSlot(church.id, "no-selector-detail");

    const detail = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("subscores");
    expect(serialised).not.toContain("selector-v1");
    expect(serialised).not.toContain("The machine's reason");
    expect(await prisma.clipScore.count({ where: { clipId: fixture.clip.id } })).toBe(1);
  });

  it("explains itself rather than offering a player when there is no file", async () => {
    const church = await createChurch("Unplayable Detail");
    const unfinished = await createReviewableSlot(church.id, "unfinished", {
      withOutput: false,
      state: ProcessingJobState.RUNNING,
    });
    const failed = await createReviewableSlot(church.id, "failed", {
      withOutput: false,
      state: ProcessingJobState.FAILED,
    });

    const running = await loadOperatorReviewDetail(prisma, unfinished.slot.id);
    expect(running?.playbackUrl).toBeNull();
    expect(running?.unplayableReason).toMatch(/has not finished/);

    const broken = await loadOperatorReviewDetail(prisma, failed.slot.id);
    expect(broken?.playbackUrl).toBeNull();
    expect(broken?.unplayableReason).toMatch(/render failed/);
  });

  it("refuses to identify a render with no QC checksum", async () => {
    const church = await createChurch("No Checksum Detail");
    const fixture = await createReviewableSlot(church.id, "no-checksum");
    await prisma.exportJob.update({
      where: { id: fixture.exportJob.id },
      data: { qcChecksum: null },
    });

    const detail = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    expect(detail?.identity).toBeNull();
    expect(detail?.playbackUrl).toBeNull();
    expect(detail?.unplayableReason).toMatch(/cannot be identified/);
  });

  it("shows the decision history newest first, and flags the ones about an earlier file", async () => {
    const church = await createChurch("History Detail");
    const fixture = await createReviewableSlot(church.id, "history");

    await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.REVISE,
      identity: fixture.identity,
      reviewerUserId: reviewerId,
      note: "Caption sits low.",
      feedback: [{ category: "CAPTION", note: "Overlaps the lower third." }],
    });
    await appendClipReview(prisma, {
      scheduledPostId: fixture.slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: fixture.identity,
      reviewerUserId: reviewerId,
    });

    const detail = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    expect(detail?.history).toHaveLength(2);
    expect(detail?.history[0].decision).toBe(ClipReviewDecision.ACCEPT);
    expect(detail?.history[1].decision).toBe(ClipReviewDecision.REVISE);
    expect(detail?.history.every((entry) => entry.aboutCurrentRender)).toBe(true);
    expect(detail?.history[1].feedback).toHaveLength(1);
    expect(detail?.history[1].feedback[0].note).toBe("Overlaps the lower third.");

    // Rebuild the file: both decisions were about bytes that no longer exist.
    await prisma.exportJob.update({
      where: { id: fixture.exportJob.id },
      data: { qcChecksum: "sha256:rebuilt-history" },
    });
    const after = await loadOperatorReviewDetail(prisma, fixture.slot.id);
    expect(after?.history.every((entry) => entry.aboutCurrentRender)).toBe(false);
  });

  it("returns nothing for a slot that does not exist", async () => {
    await expect(
      loadOperatorReviewDetail(prisma, "00000000-0000-0000-0000-0000000000ff"),
    ).resolves.toBeNull();
  });
});
