import {
  AuthProvider,
  ClipReviewDecision,
  EditorialProgramState,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  ReviewerKind,
  SchedulePublishStatus,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assessScheduledPostDelivery, collectSwitchOnlyCensus } from "@/lib/delivery/query";
import {
  collectStartEvidence,
  editorialProgramStatus,
  missingEvidence,
  pauseEditorialProgram,
  ProgramAlreadyStartedError,
  ProgramEvidenceMissingError,
  resumeEditorialProgram,
  startEditorialProgram,
  verifySandboxProof,
} from "@/lib/review/editorial-program";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";
import { appendClipReview } from "@/lib/review/service";

/**
 * The start sequence, against real rows.
 *
 * **On the dates.** The census is a global query by design — it must scan exactly what the
 * publisher would. Every slot here is therefore scheduled in 2019 and every census is taken with a
 * `now` in 2019, which is earlier than the earliest date any other integration file uses (2026).
 * Rows left behind by other files are not due at that instant, so "exactly one row" means exactly
 * one of *these* rows. Filtering the census by workspace would have been easier and would have
 * tested something the operator never runs.
 */

const prisma = new PrismaClient();
const originalPublishingEnabled = process.env.AUTOMATIC_PUBLISHING_ENABLED;

let userId: string;
let workspaceId: string;
let serial = 0;

const CENSUS_NOW = new Date(Date.UTC(2019, 6, 1));

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2019, 0, serial));
}

const eligibleSettings = {
  churchProfile: {
    timezone: "America/Chicago",
    serviceDay: "Sunday",
    sermonsPerWeek: 1,
    postsPerDay: 1,
  },
  facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true },
};

/** A slot that fails delivery for the global switch and nothing else, once accepted. */
async function createDeliverableSlot(label: string, options: { accept?: boolean } = {}) {
  serial += 1;
  const project = await prisma.project.create({
    data: { workspaceId, name: `Program ${label} ${serial}` },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: serial,
      startMs: 0,
      endMs: 30_000,
      title: `Program clip ${label}`,
      hookText: "Seeded for the program tests.",
      summary: "Program fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  await prisma.clipEdit.create({
    data: { clipId: clip.id, version: 1, editorState: {}, savedBy: null },
  });

  const checksum = `sha256-${uniqueKey(label)}`;
  const outputFile = await prisma.exportedFile.create({
    data: {
      storageKey: `exports/${workspaceId}/${uniqueKey(label)}.mp4`,
      bytes: BigInt(1024),
      width: 1080,
      height: 1920,
      checksum,
      downloadExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const exportJob = await prisma.exportJob.create({
    data: {
      workspaceId,
      clipId: clip.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: uniqueKey(`export-${label}`),
      filename: `${label}.mp4`,
      outputFileId: outputFile.id,
      editVersion: 1,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: checksum,
      finishedAt: new Date(Date.UTC(2018, 11, 1)),
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

  if (options.accept ?? true) {
    await appendClipReview(prisma, {
      scheduledPostId: slot.id,
      decision: ClipReviewDecision.ACCEPT,
      identity: {
        clipId: clip.id,
        exportJobId: exportJob.id,
        editVersion: 1,
        checksum,
      },
      reviewerUserId: userId,
    });
  }

  return { project, clip, exportJob, slot };
}

/** Takes a slot out of the census without deleting the evidence attached to it. */
async function retire(scheduledPostId: string) {
  await prisma.scheduledPost.update({
    where: { id: scheduledPostId },
    data: { publishStatus: SchedulePublishStatus.BLOCKED },
  });
}

beforeAll(async () => {
  process.env.AUTOMATIC_PUBLISHING_ENABLED = "false";
  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("program")}@example.com`,
      authProvider: AuthProvider.DEV,
      isPlatformOperator: true,
    },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      ownerId: user.id,
      name: "Editorial program tests",
      settings: eligibleSettings as Prisma.InputJsonValue,
    },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role: WorkspaceRole.OWNER },
  });
});

beforeEach(async () => {
  // The program is one row for the whole installation, so each case starts from none.
  await prisma.editorialProgram.deleteMany({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
});

afterAll(async () => {
  await prisma.editorialProgram.deleteMany({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await prisma.user.delete({ where: { id: userId } });
  if (originalPublishingEnabled === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
  else process.env.AUTOMATIC_PUBLISHING_ENABLED = originalPublishingEnabled;
  await prisma.$disconnect();
});

describe("the switch-only census", () => {
  it("finds nothing when no due row is one flip away from publishing", async () => {
    const unreviewed = await createDeliverableSlot("census-empty", { accept: false });

    const census = await collectSwitchOnlyCensus(prisma, { now: CENSUS_NOW });
    expect(census.globalPublishingEnabled).toBe(false);
    expect(census.switchOnly).toHaveLength(0);

    // And it did see the row — it simply would not publish for a second reason.
    const seen = census.rows.find((row) => row.scheduledPostId === unreviewed.slot.id);
    expect(seen?.withSwitchOn).toEqual({
      eligible: false,
      reason: "editorial_review_missing",
    });

    await retire(unreviewed.slot.id);
  });

  it("finds exactly the row a person accepted", async () => {
    const accepted = await createDeliverableSlot("census-one");

    const census = await collectSwitchOnlyCensus(prisma, { now: CENSUS_NOW });
    expect(census.switchOnly.map((row) => row.scheduledPostId)).toEqual([accepted.slot.id]);
    expect(census.switchOnly[0].actual).toEqual({
      eligible: false,
      reason: "global_publishing_disabled",
    });

    await retire(accepted.slot.id);
  });

  it("finds every one of them when several are ready", async () => {
    const first = await createDeliverableSlot("census-many-1");
    const second = await createDeliverableSlot("census-many-2");
    const third = await createDeliverableSlot("census-many-3");

    const census = await collectSwitchOnlyCensus(prisma, { now: CENSUS_NOW });
    expect(new Set(census.switchOnly.map((row) => row.scheduledPostId))).toEqual(
      new Set([first.slot.id, second.slot.id, third.slot.id]),
    );

    for (const slot of [first, second, third]) await retire(slot.slot.id);
  });
});

describe("the sandbox proof", () => {
  it("passes when the intended row is the only one a flip would release", async () => {
    const intended = await createDeliverableSlot("proof-pass");

    const proof = await verifySandboxProof(prisma, {
      intendedScheduledPostId: intended.slot.id,
      now: CENSUS_NOW,
    });
    expect(proof.ok).toBe(true);

    // The refusal and the pass are both recorded, so the decision to enable is auditable.
    const event = await prisma.operationalEvent.findFirst({
      where: { category: "editorial_program", eventType: "sandbox_proof_passed" },
      orderBy: { createdAt: "desc" },
    });
    expect(event?.metadata).toMatchObject({ intendedScheduledPostId: intended.slot.id });

    await retire(intended.slot.id);
  });

  it("refuses when the intended row would still fail for another reason", async () => {
    const intended = await createDeliverableSlot("proof-unreviewed", { accept: false });

    const proof = await verifySandboxProof(prisma, {
      intendedScheduledPostId: intended.slot.id,
      now: CENSUS_NOW,
    });
    expect(proof).toMatchObject({ ok: false, reason: "intended_row_not_switch_only" });
    if (!proof.ok) expect(proof.detail).toContain("editorial_review_missing");

    await retire(intended.slot.id);
  });

  it("refuses when the intended row is not due at all", async () => {
    const intended = await createDeliverableSlot("proof-not-due");
    await retire(intended.slot.id);

    const proof = await verifySandboxProof(prisma, {
      intendedScheduledPostId: intended.slot.id,
      now: CENSUS_NOW,
    });
    expect(proof).toMatchObject({ ok: false, reason: "intended_row_not_switch_only" });
    if (!proof.ok) expect(proof.detail).toContain("not among the due rows");
  });

  /**
   * The case the plan states twice, because it is the one that matters: a second accepted clip
   * would go out alongside the sandbox clip the moment the switch flipped, and nobody intended it.
   */
  it("refuses when any other row would publish alongside the intended one", async () => {
    const intended = await createDeliverableSlot("proof-intended");
    const bystander = await createDeliverableSlot("proof-bystander");

    const proof = await verifySandboxProof(prisma, {
      intendedScheduledPostId: intended.slot.id,
      now: CENSUS_NOW,
    });
    expect(proof).toMatchObject({ ok: false, reason: "other_rows_would_publish" });
    if (!proof.ok) expect(proof.detail).toContain(bystander.slot.id);

    // And it passes once the bystander is no longer due — the proof is about the population, not
    // about the intended row in isolation.
    await retire(bystander.slot.id);
    await expect(
      verifySandboxProof(prisma, {
        intendedScheduledPostId: intended.slot.id,
        now: CENSUS_NOW,
      }),
    ).resolves.toMatchObject({ ok: true });

    await retire(intended.slot.id);
  });

  it("refuses outright once publishing is already enabled", async () => {
    const intended = await createDeliverableSlot("proof-switch-on");
    process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
    try {
      const proof = await verifySandboxProof(prisma, {
        intendedScheduledPostId: intended.slot.id,
        now: CENSUS_NOW,
      });
      expect(proof).toMatchObject({ ok: false, reason: "global_switch_already_enabled" });
    } finally {
      process.env.AUTOMATIC_PUBLISHING_ENABLED = "false";
      await retire(intended.slot.id);
    }
  });
});

describe("starting the clock", () => {
  async function proveEverything(label: string) {
    const accepted = await createDeliverableSlot(label);
    // The sandbox publication: the accepted render, having gone out to a real Page.
    await prisma.scheduledPost.update({
      where: { id: accepted.slot.id },
      data: {
        publishStatus: SchedulePublishStatus.SUCCEEDED,
        facebookPostId: `fb-${uniqueKey(label)}`,
        publishedAt: new Date(),
      },
    });
    // The atomic replacement. Written directly because P2.7's command owns the only other route
    // and this test is about the start command, not about replacement.
    const replaced = await createDeliverableSlot(`${label}-replaced`, { accept: false });
    await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: replaced.project.id,
        scheduledPostIdSnapshot: replaced.slot.id,
        clipIdSnapshot: replaced.clip.id,
        clipRank: 1,
        clipStartMs: 0,
        clipEndMs: 30_000,
        exportJobIdSnapshot: replaced.exportJob.id,
        editVersion: 1,
        checksum: replaced.exportJob.qcChecksum as string,
        decision: ClipReviewDecision.REPLACE,
        reviewerUserId: userId,
      },
    });
    await retire(replaced.slot.id);
    return accepted;
  }

  /**
   * Which rows count as evidence, asserted about this test's own rows.
   *
   * `collectStartEvidence` asks an installation-wide question and returns the first row that
   * answers it, so "no evidence exists" is not a state this file can create — another file's
   * fixtures would answer it. What *is* deterministic, and is the part worth proving, is that a
   * given row is or is not accepted as evidence. `missingEvidence` covers the refusal itself
   * exhaustively in `tests/editorial-program.test.ts`, where the input is a value rather than a
   * database.
   */
  it("does not accept a publication of a render nobody agreed to", async () => {
    const unreviewed = await createDeliverableSlot("evidence-unreviewed", { accept: false });
    await prisma.scheduledPost.update({
      where: { id: unreviewed.slot.id },
      data: {
        publishStatus: SchedulePublishStatus.SUCCEEDED,
        facebookPostId: `fb-${uniqueKey("unreviewed")}`,
        publishedAt: new Date(),
      },
    });

    const evidence = await collectStartEvidence(prisma);
    expect(evidence.sandboxPublication?.scheduledPostId).not.toBe(unreviewed.slot.id);
    expect(evidence.exactAcceptedRender?.scheduledPostId).not.toBe(unreviewed.slot.id);
  });

  it("stops accepting an acceptance once its render has moved underneath it", async () => {
    const accepted = await createDeliverableSlot("evidence-rerendered");
    await prisma.scheduledPost.update({
      where: { id: accepted.slot.id },
      data: {
        publishStatus: SchedulePublishStatus.SUCCEEDED,
        facebookPostId: `fb-${uniqueKey("rerendered")}`,
        publishedAt: new Date(),
      },
    });

    // While it still matches, this row is evidence of both facts.
    const before = await collectStartEvidence(prisma);
    const wasEvidence =
      before.exactAcceptedRender?.scheduledPostId === accepted.slot.id ||
      before.sandboxPublication?.scheduledPostId === accepted.slot.id;
    expect(wasEvidence).toBe(true);

    // A rebuild of the same export. Same slot, same clip, same id, different bytes.
    const rebuilt = `sha256-${uniqueKey("rebuilt")}`;
    await prisma.exportJob.update({
      where: { id: accepted.exportJob.id },
      data: { qcChecksum: rebuilt },
    });
    await prisma.exportedFile.update({
      where: { id: accepted.exportJob.outputFileId as string },
      data: { checksum: rebuilt },
    });

    const after = await collectStartEvidence(prisma);
    expect(after.exactAcceptedRender?.scheduledPostId).not.toBe(accepted.slot.id);
    expect(after.sandboxPublication?.scheduledPostId).not.toBe(accepted.slot.id);
  });

  it("refuses to start while the three preconditions are unproved", async () => {
    // Proved by construction rather than by absence: a database with no qualifying row is not a
    // state this file can create, so the refusal is exercised on the value `missingEvidence`
    // returns, which is what `startEditorialProgram` actually branches on.
    expect(
      missingEvidence({
        exactAcceptedRender: null,
        atomicReplacement: null,
        sandboxPublication: null,
      }),
    ).toHaveLength(3);
    expect(new ProgramEvidenceMissingError(["nothing is proved"]).message).toContain(
      "cannot start until the system has been proved end to end",
    );
  });

  it("starts on the evidence, records who, and does not backdate", async () => {
    await proveEverything("start-ok");

    const before = Date.now();
    const program = await startEditorialProgram(prisma, { startedByUserId: userId });
    const after = Date.now();

    expect(program.state).toBe(EditorialProgramState.ACTIVE);
    expect(program.minimumDays).toBe(30);
    expect(program.startedByUserId).toBe(userId);
    // The clock starts now. There is no parameter that could have moved it.
    expect(program.startedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(program.startedAt!.getTime()).toBeLessThanOrEqual(after);

    // The evidence is written into the row, so the start is self-describing afterwards.
    expect(program.startEvidence).toMatchObject({
      exactAcceptedRender: { scheduledPostId: expect.any(String) },
      atomicReplacement: { reviewId: expect.any(String) },
      sandboxPublication: { facebookPostId: expect.any(String) },
    });
  });

  it("cannot be started twice", async () => {
    await proveEverything("start-twice");
    await startEditorialProgram(prisma, { startedByUserId: userId });

    await expect(startEditorialProgram(prisma, { startedByUserId: userId })).rejects.toBeInstanceOf(
      ProgramAlreadyStartedError,
    );
  });

  it("cannot be restarted after a pause, which would erase elapsed history", async () => {
    await proveEverything("start-after-pause");
    await startEditorialProgram(prisma, { startedByUserId: userId });
    await pauseEditorialProgram(prisma, { reason: "operator check" });

    await expect(startEditorialProgram(prisma, { startedByUserId: userId })).rejects.toBeInstanceOf(
      ProgramAlreadyStartedError,
    );
  });
});

describe("pausing", () => {
  it("stops delivery everywhere, and resuming banks the pause", async () => {
    const slot = await createDeliverableSlot("pause-delivery");
    process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
    try {
      // Publishing on, accepted, exact: eligible.
      await expect(
        assessScheduledPostDelivery(prisma, { scheduledPostId: slot.slot.id }),
      ).resolves.toEqual({ eligible: true });

      await prisma.editorialProgram.create({
        data: {
          key: HUMAN_REFERENCE_PROGRAM_KEY,
          state: EditorialProgramState.ACTIVE,
          startedAt: new Date(Date.now() - 5 * 86_400_000),
          startedByUserId: userId,
        },
      });
      await pauseEditorialProgram(prisma, { reason: "a caption defect reached a church" });

      await expect(
        assessScheduledPostDelivery(prisma, { scheduledPostId: slot.slot.id }),
      ).resolves.toEqual({ eligible: false, reason: "editorial_program_paused" });

      // Elapsed history is held, not erased: five days in, still five days in.
      const paused = await editorialProgramStatus(prisma);
      expect(paused?.elapsedDays).toBe(5);

      const resumed = await resumeEditorialProgram(prisma);
      expect(resumed.state).toBe(EditorialProgramState.ACTIVE);
      expect(Number(resumed.pausedMs)).toBeGreaterThanOrEqual(0);
      await expect(
        assessScheduledPostDelivery(prisma, { scheduledPostId: slot.slot.id }),
      ).resolves.toEqual({ eligible: true });
    } finally {
      process.env.AUTOMATIC_PUBLISHING_ENABLED = "false";
      await retire(slot.slot.id);
    }
  });

  it("leaves delivery alone while the program has never started", async () => {
    const slot = await createDeliverableSlot("pause-none");
    process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
    try {
      // NOT_STARTED must not refuse: the sandbox proof publishes one row before the clock starts,
      // and a rule that demanded an ACTIVE program would make that evidence uncollectable.
      await expect(
        assessScheduledPostDelivery(prisma, { scheduledPostId: slot.slot.id }),
      ).resolves.toEqual({ eligible: true });
    } finally {
      process.env.AUTOMATIC_PUBLISHING_ENABLED = "false";
      await retire(slot.slot.id);
    }
  });
});

describe("the status report", () => {
  it("counts only what happened inside the window, and flags an agent row", async () => {
    const program = await prisma.editorialProgram.create({
      data: {
        key: HUMAN_REFERENCE_PROGRAM_KEY,
        state: EditorialProgramState.ACTIVE,
        startedAt: new Date(),
        startedByUserId: userId,
      },
    });
    expect(program.startedAt).not.toBeNull();

    const inWindow = await createDeliverableSlot("status-window");
    await prisma.clipReview.create({
      data: {
        workspaceId,
        projectIdSnapshot: inWindow.project.id,
        scheduledPostIdSnapshot: inWindow.slot.id,
        clipIdSnapshot: inWindow.clip.id,
        clipRank: 1,
        clipStartMs: 0,
        clipEndMs: 30_000,
        exportJobIdSnapshot: inWindow.exportJob.id,
        editVersion: 1,
        checksum: inWindow.exportJob.qcChecksum as string,
        decision: ClipReviewDecision.ACCEPT,
        reviewerKind: ReviewerKind.AGENT,
      },
    });

    const status = await editorialProgramStatus(prisma);
    expect(status?.agentReviews).toBe(1);
    expect(status?.decisions.accept).toBeGreaterThanOrEqual(1);
    expect(status?.humanAuthoritative).toBe(true);
    expect(status?.minimumMet).toBe(false);

    await retire(inWindow.slot.id);
  });

  it("reports nothing at all before the program exists", async () => {
    await expect(editorialProgramStatus(prisma)).resolves.toBeNull();
  });
});
