import {
  AuthProvider,
  EditorialExceptionState,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProjectStatus,
  RenderQcStatus,
  SchedulePublishStatus,
  SourceOrigin,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "@/lib/analysis/clip-status";
import {
  rescheduleMissedSlot,
  RescheduleMissedRefusedError,
} from "@/lib/schedule/reschedule-missed";
import { SOURCE_RETENTION_TAIL_DAYS } from "@/lib/retention";

/**
 * Moving a missed post, against real rows.
 *
 * The database rules are the substance: one non-`MISSED` row per workspace date, and one globally
 * unique `clip_id`. Both would be violated by inserting a second row, which is why this command
 * mutates in place — and both are asserted here rather than reasoned about.
 */

const prisma = new PrismaClient();
let operatorId: string;
let workspaceId: string;
let projectId: string;
let sourceVideoId: string;
let serial = 0;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

/** Far-future dates, so "the past" is never ambiguous while these run. */
function futureDate(dayOfMonth: number) {
  return new Date(Date.UTC(2060, 5, dayOfMonth));
}

async function createMissedSlot(label: string, options: { withExport?: boolean } = {}) {
  serial += 1;
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: serial,
      startMs: serial * 1000,
      endMs: serial * 1000 + 30_000,
      title: `Missed ${label}`,
      summary: "Reschedule fixture.",
      status: ANALYSIS_RETAINED_CLIP_STATUS,
    },
  });

  let exportJobId: string | null = null;
  if (options.withExport ?? true) {
    const job = await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: clip.id,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: uniqueKey(`resched-${label}`),
        filename: `${label}.mp4`,
        editVersion: 1,
        qcStatus: RenderQcStatus.PASSED,
        qcChecksum: `sha256-${uniqueKey(label)}`,
      },
    });
    exportJobId = job.id;
  }

  // A missed row releases its date under the partial unique index, so these can share one.
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId,
      clipId: clip.id,
      exportJobId,
      scheduledDate: new Date(Date.UTC(2060, 0, 5)),
      publishStatus: SchedulePublishStatus.MISSED,
    },
  });
  const exception = await prisma.editorialException.create({
    data: {
      workspaceId,
      projectId,
      scheduledPostId: slot.id,
      exceptionType: "posting_date_missed",
      state: EditorialExceptionState.OPEN,
      message: "This date passed without publishing.",
    },
  });
  return { clip, slot, exception, exportJobId };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("resched-op")}@example.com`,
      authProvider: AuthProvider.DEV,
      isPlatformOperator: true,
    },
  });
  operatorId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      ownerId: user.id,
      name: "Reschedule tests",
      settings: {
        churchProfile: {
          timezone: "America/Chicago",
          serviceDay: "Sunday",
          sermonsPerWeek: 1,
          postsPerDay: 1,
        },
      } as Prisma.InputJsonValue,
    },
  });
  workspaceId = workspace.id;
  const source = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "resched.mp4",
      storageKey: `src/${workspaceId}/resched.mp4`,
    },
  });
  sourceVideoId = source.id;
  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: "Reschedule service",
      sourceVideoId,
      status: ProjectStatus.READY,
      sermonDate: new Date(Date.UTC(2060, 0, 4)),
    },
  });
  projectId = project.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (operatorId) await prisma.user.delete({ where: { id: operatorId } });
  await prisma.$disconnect();
});

describe("moving the same row", () => {
  it("moves the date, reopens the slot, and keeps the exact binding", async () => {
    const s = await createMissedSlot("happy");
    const newDate = futureDate(2); // 2060-06-02 is a Wednesday.
    const before = await prisma.scheduledPost.count({ where: { workspaceId } });

    const outcome = await rescheduleMissedSlot(prisma, {
      scheduledPostId: s.slot.id,
      newDate,
      operatorUserId: operatorId,
    });

    expect(outcome.newDate.toISOString()).toBe(newDate.toISOString());
    expect(outcome.clipId).toBe(s.clip.id);

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.scheduledDate.toISOString()).toBe(newDate.toISOString());
    expect(slot.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);
    // The binding is retained, never re-derived — no lookup for a fresher render.
    expect(slot.clipId).toBe(s.clip.id);
    expect(slot.exportJobId).toBe(s.exportJobId);
    // Retry facts belong to the attempt that did not happen; they reset.
    expect(slot.attemptCount).toBe(0);
    expect(slot.nextAttemptAt).toBeNull();
    expect(slot.lastErrorMessage).toBeNull();

    // The same row moved. Nothing was inserted, which the unique `clip_id` would have refused.
    expect(await prisma.scheduledPost.count({ where: { workspaceId } })).toBe(before);
    expect(await prisma.scheduledPost.count({ where: { clipId: s.clip.id } })).toBe(1);
  });

  it("resolves the missed-date exception in place", async () => {
    const s = await createMissedSlot("exception");
    const outcome = await rescheduleMissedSlot(prisma, {
      scheduledPostId: s.slot.id,
      newDate: futureDate(3),
      operatorUserId: operatorId,
    });

    const exception = await prisma.editorialException.findUniqueOrThrow({
      where: { id: s.exception.id },
    });
    expect(exception.state).toBe(EditorialExceptionState.RESOLVED);
    expect(exception.resolvedByUserId).toBe(operatorId);
    // The evidence survives its resolution.
    expect(exception.message).toBe("This date passed without publishing.");
    expect(outcome.resolvedExceptionIds).toEqual([s.exception.id]);
  });

  it("extends retention past the new date", async () => {
    const s = await createMissedSlot("retention");
    await prisma.project.update({
      where: { id: projectId },
      data: { expiresAt: new Date(Date.UTC(2060, 0, 6)) },
    });
    const newDate = futureDate(4);

    await rescheduleMissedSlot(prisma, {
      scheduledPostId: s.slot.id,
      newDate,
      operatorUserId: operatorId,
    });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const tail = new Date(newDate);
    tail.setUTCDate(tail.getUTCDate() + SOURCE_RETENTION_TAIL_DAYS);
    expect(project.expiresAt!.getTime()).toBeGreaterThanOrEqual(tail.getTime());
  });

  it("audits the move with both dates", async () => {
    const s = await createMissedSlot("audit");
    await rescheduleMissedSlot(prisma, {
      scheduledPostId: s.slot.id,
      newDate: futureDate(7),
      operatorUserId: operatorId,
    });

    const event = await prisma.operationalEvent.findFirstOrThrow({
      where: { workspaceId, eventType: "missed_post_rescheduled" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({
      previousDate: "2060-01-05",
      newDate: "2060-06-07",
      operatorUserId: operatorId,
    });
  });
});

describe("what a reschedule refuses", () => {
  it("refuses a slot that is not missed, and changes nothing", async () => {
    const s = await createMissedSlot("not-missed");
    await prisma.scheduledPost.update({
      where: { id: s.slot.id },
      data: { publishStatus: SchedulePublishStatus.SUCCEEDED, facebookPostId: "fb-1" },
    });

    await expect(
      rescheduleMissedSlot(prisma, {
        scheduledPostId: s.slot.id,
        newDate: futureDate(8),
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "slot_not_missed" });

    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: s.slot.id } });
    expect(slot.scheduledDate.toISOString()).toBe(new Date(Date.UTC(2060, 0, 5)).toISOString());
  });

  it("refuses a Sunday", async () => {
    const s = await createMissedSlot("sunday");
    // 2060-06-06 is a Sunday.
    await expect(
      rescheduleMissedSlot(prisma, {
        scheduledPostId: s.slot.id,
        newDate: futureDate(6),
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "date_is_sunday" });
  });

  it("refuses a date the church already has booked", async () => {
    const s = await createMissedSlot("collision");
    const taken = futureDate(9);
    const other = await createMissedSlot("collision-holder");
    await rescheduleMissedSlot(prisma, {
      scheduledPostId: other.slot.id,
      newDate: taken,
      operatorUserId: operatorId,
    });

    await expect(
      rescheduleMissedSlot(prisma, {
        scheduledPostId: s.slot.id,
        newDate: taken,
        operatorUserId: operatorId,
      }),
    ).rejects.toMatchObject({ reason: "date_already_taken" });
  });

  it("refuses a detached row whose clip was regenerated away", async () => {
    const s = await createMissedSlot("detached", { withExport: false });
    await prisma.generatedClip.delete({ where: { id: s.clip.id } });

    await expect(
      rescheduleMissedSlot(prisma, {
        scheduledPostId: s.slot.id,
        newDate: futureDate(10),
        operatorUserId: operatorId,
      }),
    ).rejects.toBeInstanceOf(RescheduleMissedRefusedError);
  });

  /**
   * Two operators picking the same free day at the same instant. The count check above cannot see
   * an uncommitted rival, so the partial unique index is the real arbiter and its violation is
   * reported as the refusal it is rather than as a crash.
   */
  it("gives one date to one slot when two moves race for it", async () => {
    const first = await createMissedSlot("race-a");
    const second = await createMissedSlot("race-b");
    const contested = futureDate(11);

    const results = await Promise.allSettled([
      rescheduleMissedSlot(prisma, {
        scheduledPostId: first.slot.id,
        newDate: contested,
        operatorUserId: operatorId,
      }),
      rescheduleMissedSlot(prisma, {
        scheduledPostId: second.slot.id,
        newDate: contested,
        operatorUserId: operatorId,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.scheduledPost.count({
        where: {
          workspaceId,
          scheduledDate: contested,
          publishStatus: { not: SchedulePublishStatus.MISSED },
        },
      }),
    ).toBe(1);
  });
});

describe("automation never calls this", () => {
  /**
   * `MISSED` is terminal for automation (Addendum Decision O). The guarantee is structural: no
   * sweep, coordinator, publisher or allocator imports this module, so a missed date cannot move
   * unless a person moves it.
   */
  it("has no caller outside the operator action", async () => {
    const { execSync } = await import("node:child_process");
    // The command module's exact import path, closing quote included. A looser pattern also
    // matches `reschedule-missed-form.tsx` and the page that renders it, neither of which imports
    // the command — which is precisely the difference this test is about.
    const hits = execSync(
      `grep -rl '@/lib/schedule/reschedule-missed"' src/ || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    expect(hits.sort()).toEqual(["src/app/actions/operator-reschedule-missed.ts"]);
  });
});
