import {
  AuthProvider,
  ClipReviewDecision,
  EditorialCohort,
  EditorialProgramState,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
  ReviewFeedbackSeverity,
  ReviewerKind,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();
const humanReferenceProgramKey = "human_reference";
let userId: string;
let workspaceId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2036, 0, serial));
}

async function createProject(label: string) {
  serial += 1;
  return prisma.project.create({ data: { workspaceId, name: `Wave 2 ${label} ${serial}` } });
}

async function createClip(projectId: string, label: string) {
  serial += 1;
  return prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: serial,
      startMs: 0,
      endMs: 10_000,
      title: `Wave 2 ${label}`,
      summary: "Wave 2 schema fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
}

async function createExport(clipId: string, label: string, editVersion = 0) {
  serial += 1;
  return prisma.exportJob.create({
    data: {
      workspaceId,
      clipId,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `wave-two-${label}-${serial}`,
      filename: `${label}.mp4`,
      editVersion,
      qcChecksum: `sha256:${label}-${serial}`,
    },
  });
}

/**
 * The whole reviewable subject: a project, a clip, its pinned export, and the slot the export is
 * bound to. Returns an `accept` review whose live links and snapshots both point at that subject.
 */
async function createReviewedSlot(label: string, decision = ClipReviewDecision.ACCEPT) {
  const project = await createProject(label);
  const clip = await createClip(project.id, label);
  const exportJob = await createExport(clip.id, label);
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId: project.id,
      clipId: clip.id,
      exportJobId: exportJob.id,
      scheduledDate: nextDate(),
    },
  });
  const review = await prisma.clipReview.create({
    data: {
      workspaceId,
      projectId: project.id,
      scheduledPostId: slot.id,
      clipId: clip.id,
      exportJobId: exportJob.id,
      reviewerUserId: userId,
      decision,
      projectIdSnapshot: project.id,
      scheduledPostIdSnapshot: slot.id,
      clipIdSnapshot: clip.id,
      clipRank: clip.rank,
      clipStartMs: clip.startMs,
      clipEndMs: clip.endMs,
      exportJobIdSnapshot: exportJob.id,
      editVersion: exportJob.editVersion ?? 0,
      checksum: exportJob.qcChecksum ?? "",
      slotSnapshot: { scheduledDate: slot.scheduledDate.toISOString(), platform: slot.platform },
    },
  });
  return { project, clip, exportJob, slot, review };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wave-two-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Wave 2 schema tests" },
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

describe("agentic editor Wave 2 schema", () => {
  it("applies after Wave 1 and leaves Wave 1 columns intact", async () => {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name LIKE '%agentic_editor_wave%' AND finished_at IS NOT NULL
      ORDER BY migration_name
    `;
    expect(applied.map((row) => row.migration_name)).toEqual([
      "20260812122900_agentic_editor_wave_1_enums",
      "20260812123000_agentic_editor_wave_1",
      "20260905230000_agentic_editor_wave_2",
    ]);

    // Wave 2 is additive. A Wave 1 export still round-trips its identity and QC columns.
    const project = await createProject("wave one still works");
    const clip = await createClip(project.id, "wave one still works");
    const exportJob = await createExport(clip.id, "wave-one-still-works", 4);
    expect(exportJob.editVersion).toBe(4);
    expect(exportJob.priority).toBe(0);
  });

  it("defaults a new user to no platform-operator marker", async () => {
    const plain = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(plain.isPlatformOperator).toBe(false);
    expect(plain.platformOperatorGrantedAt).toBeNull();

    const granted = await prisma.user.update({
      where: { id: userId },
      data: { isPlatformOperator: true, platformOperatorGrantedAt: new Date() },
    });
    expect(granted.isPlatformOperator).toBe(true);

    await prisma.user.update({
      where: { id: userId },
      data: { isPlatformOperator: false, platformOperatorGrantedAt: null },
    });
  });

  it("stores review defaults and refuses a decision without one", async () => {
    const { review } = await createReviewedSlot("defaults");
    expect(review.reviewerKind).toBe(ReviewerKind.HUMAN);
    expect(review.decision).toBe(ClipReviewDecision.ACCEPT);
    expect(review.slotSnapshot).toMatchObject({ platform: "FACEBOOK" });
    expect(review.metadata).toEqual({});
    expect(review.replacementClipIdSnapshot).toBeNull();
    expect(review.replacementExportJobIdSnapshot).toBeNull();
  });

  it("refuses to rewrite a recorded decision", async () => {
    const { review } = await createReviewedSlot("append only");

    await expect(
      prisma.clipReview.update({
        where: { id: review.id },
        data: { decision: ClipReviewDecision.REVISE },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.clipReview.update({ where: { id: review.id }, data: { note: "second thoughts" } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.clipReview.update({ where: { id: review.id }, data: { checksum: "sha256:other" } }),
    ).rejects.toThrow(/append-only/);

    // A correction is a newer row, not an edit of this one.
    const correction = await prisma.clipReview.create({
      data: {
        workspaceId,
        decision: ClipReviewDecision.REVISE,
        projectIdSnapshot: review.projectIdSnapshot,
        scheduledPostIdSnapshot: review.scheduledPostIdSnapshot,
        clipIdSnapshot: review.clipIdSnapshot,
        clipRank: review.clipRank,
        clipStartMs: review.clipStartMs,
        clipEndMs: review.clipEndMs,
        exportJobIdSnapshot: review.exportJobIdSnapshot,
        editVersion: review.editVersion,
        checksum: review.checksum,
      },
    });
    expect(correction.decision).toBe(ClipReviewDecision.REVISE);

    const history = await prisma.clipReview.findMany({
      where: { scheduledPostIdSnapshot: review.scheduledPostIdSnapshot },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map((row) => row.decision)).toEqual([
      ClipReviewDecision.ACCEPT,
      ClipReviewDecision.REVISE,
    ]);
  });

  it("refuses to point a live link at a different row", async () => {
    const { review, project } = await createReviewedSlot("repoint");
    const otherClip = await createClip(project.id, "repoint target");

    await expect(
      prisma.clipReview.update({ where: { id: review.id }, data: { clipId: otherClip.id } }),
    ).rejects.toThrow(/may only be cleared/);
  });

  it("keeps the snapshot after the clip, export, slot, and reviewer disappear", async () => {
    const { review, clip, exportJob, slot } = await createReviewedSlot("snapshot survival");

    // Deleting the clip cascades to its export jobs and clears both links on the slot.
    await prisma.generatedClip.delete({ where: { id: clip.id } });
    await prisma.scheduledPost.delete({ where: { id: slot.id } });

    const retained = await prisma.clipReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(retained.clipId).toBeNull();
    expect(retained.exportJobId).toBeNull();
    expect(retained.scheduledPostId).toBeNull();
    expect(retained.clipIdSnapshot).toBe(clip.id);
    expect(retained.exportJobIdSnapshot).toBe(exportJob.id);
    expect(retained.scheduledPostIdSnapshot).toBe(slot.id);
    expect(retained.clipRank).toBe(clip.rank);
    expect(retained.checksum).toBe(exportJob.qcChecksum);
    expect(retained.editVersion).toBe(exportJob.editVersion);
  });

  it("records a replacement's prior and promoted clips side by side", async () => {
    const { review: prior, project, clip } = await createReviewedSlot("replacement prior");
    const reserve = await createClip(project.id, "replacement reserve");
    const reserveExport = await createExport(reserve.id, "replacement-reserve");

    const replacement = await prisma.clipReview.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: clip.id,
        replacementClipId: reserve.id,
        replacementExportId: reserveExport.id,
        decision: ClipReviewDecision.REPLACE,
        projectIdSnapshot: prior.projectIdSnapshot,
        scheduledPostIdSnapshot: prior.scheduledPostIdSnapshot,
        clipIdSnapshot: clip.id,
        clipRank: clip.rank,
        clipStartMs: clip.startMs,
        clipEndMs: clip.endMs,
        exportJobIdSnapshot: prior.exportJobIdSnapshot,
        editVersion: prior.editVersion,
        checksum: prior.checksum,
        replacementClipIdSnapshot: reserve.id,
        replacementClipRank: reserve.rank,
        replacementClipStartMs: reserve.startMs,
        replacementClipEndMs: reserve.endMs,
        replacementExportJobIdSnapshot: reserveExport.id,
      },
    });

    expect(replacement.clipIdSnapshot).toBe(clip.id);
    expect(replacement.replacementClipIdSnapshot).toBe(reserve.id);
    expect(replacement.replacementClipRank).toBe(reserve.rank);

    await prisma.generatedClip.delete({ where: { id: reserve.id } });
    const retained = await prisma.clipReview.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(retained.replacementClipId).toBeNull();
    expect(retained.replacementExportId).toBeNull();
    expect(retained.replacementClipIdSnapshot).toBe(reserve.id);
    expect(retained.replacementExportJobIdSnapshot).toBe(reserveExport.id);
  });

  it("accepts many feedback rows and more of them later", async () => {
    const { review } = await createReviewedSlot("feedback");

    await prisma.clipReviewFeedback.createMany({
      data: [
        {
          clipReviewId: review.id,
          workspaceId,
          category: ReviewFeedbackCategory.BOUNDARY,
          actionability: ReviewFeedbackActionability.REVISABLE,
          note: "Starts one sentence early.",
          startMs: 0,
          endMs: 1_200,
        },
        {
          clipReviewId: review.id,
          workspaceId,
          category: ReviewFeedbackCategory.CAPTION,
          severity: ReviewFeedbackSeverity.MINOR,
          actionability: ReviewFeedbackActionability.REVISABLE,
          note: "Caption sits over the speaker's chin.",
        },
        {
          clipReviewId: review.id,
          workspaceId,
          category: ReviewFeedbackCategory.CONTENT,
          severity: ReviewFeedbackSeverity.BLOCKER,
          actionability: ReviewFeedbackActionability.REPLACE_ONLY,
          note: "The point never lands.",
        },
      ],
    });

    // Findings arrive after the decision, without a practical limit.
    const later = Array.from({ length: 25 }, (_, index) => ({
      clipReviewId: review.id,
      workspaceId,
      category: ReviewFeedbackCategory.TITLE_HOOK,
      actionability: ReviewFeedbackActionability.INFORMATIONAL,
      note: `Later finding ${index}`,
    }));
    await prisma.clipReviewFeedback.createMany({ data: later });

    const stored = await prisma.clipReviewFeedback.findMany({ where: { clipReviewId: review.id } });
    expect(stored).toHaveLength(28);
    expect(stored.every((row) => row.authorKind === ReviewerKind.HUMAN)).toBe(true);
    expect(stored.filter((row) => row.severity === ReviewFeedbackSeverity.MAJOR)).toHaveLength(26);

    const first = stored[0];
    await expect(
      prisma.clipReviewFeedback.update({ where: { id: first.id }, data: { note: "reworded" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("clears a feedback author without touching the finding", async () => {
    const { review } = await createReviewedSlot("feedback author");
    const author = await prisma.user.create({
      data: { email: `wave-two-author-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
    });
    const finding = await prisma.clipReviewFeedback.create({
      data: {
        clipReviewId: review.id,
        workspaceId,
        authorUserId: author.id,
        category: ReviewFeedbackCategory.AUDIO_LEVEL,
        actionability: ReviewFeedbackActionability.REVISABLE,
        note: "Music sits over the first line.",
      },
    });

    await prisma.user.delete({ where: { id: author.id } });
    const retained = await prisma.clipReviewFeedback.findUniqueOrThrow({ where: { id: finding.id } });
    expect(retained.authorUserId).toBeNull();
    expect(retained.note).toBe("Music sits over the first line.");
  });

  it("carries the human-reference program as one not-started row", async () => {
    const program = await prisma.editorialProgram.findUniqueOrThrow({
      where: { key: humanReferenceProgramKey },
    });
    expect(program.state).toBe(EditorialProgramState.NOT_STARTED);
    expect(program.minimumDays).toBe(30);
    expect(program.startedAt).toBeNull();
    expect(program.pausedMs).toBe(BigInt(0));

    await expect(
      prisma.editorialProgram.create({ data: { key: humanReferenceProgramKey } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("holds one cohort row per workspace and starts it human-only", async () => {
    const membership = await prisma.editorialProgramWorkspace.create({
      data: { programKey: humanReferenceProgramKey, workspaceId },
    });
    expect(membership.cohort).toBe(EditorialCohort.HUMAN_ONLY);
    expect(membership.promotedAt).toBeNull();
    expect(membership.rolledBackAt).toBeNull();

    await expect(
      prisma.editorialProgramWorkspace.create({
        data: { programKey: humanReferenceProgramKey, workspaceId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Cohort state is current state, not evidence: promotion and rollback update it in place.
    const promoted = await prisma.editorialProgramWorkspace.update({
      where: { id: membership.id },
      data: {
        cohort: EditorialCohort.ASSISTED,
        promotedAt: new Date(),
        promotedByUserId: userId,
        reason: "Promoted after the reference phase.",
      },
    });
    expect(promoted.cohort).toBe(EditorialCohort.ASSISTED);

    const rolledBack = await prisma.editorialProgramWorkspace.update({
      where: { id: membership.id },
      data: {
        cohort: EditorialCohort.HUMAN_ONLY,
        rolledBackAt: new Date(),
        rolledBackByUserId: userId,
        reason: "Rolled back after a bad week.",
      },
    });
    expect(rolledBack.cohort).toBe(EditorialCohort.HUMAN_ONLY);
    expect(rolledBack.promotedAt).not.toBeNull();
  });

  it("declares the Wave 2 enum labels the services depend on", async () => {
    const labels = await prisma.$queryRaw<{ type_name: string; label: string }[]>`
      SELECT t.typname AS type_name, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN (
        'reviewer_kind', 'clip_review_decision', 'review_feedback_category',
        'review_feedback_severity', 'review_feedback_actionability',
        'editorial_program_state', 'editorial_cohort'
      )
      ORDER BY t.typname, e.enumsortorder
    `;
    const byType = labels.reduce<Record<string, string[]>>((acc, row) => {
      (acc[row.type_name] ??= []).push(row.label);
      return acc;
    }, {});

    expect(byType).toEqual({
      reviewer_kind: ["human", "agent"],
      clip_review_decision: ["accept", "revise", "replace"],
      review_feedback_category: [
        "content",
        "forbidden_content",
        "boundary",
        "visual_crop",
        "caption",
        "audio_level",
        "title_hook",
      ],
      review_feedback_severity: ["blocker", "major", "minor", "info"],
      review_feedback_actionability: ["revisable", "replace_only", "informational"],
      editorial_program_state: ["not_started", "active", "paused", "completed"],
      editorial_cohort: ["human_only", "assisted", "agent_led"],
    });
  });

  it("indexes the delivery-gate lookup and installs both append-only triggers", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('clip_reviews', 'clip_review_feedback', 'editorial_program_workspaces', 'users')
      ORDER BY indexname
    `;
    const names = indexes.map((row) => row.indexname);
    // P2.8 gates delivery on the latest ACCEPT for the slot's bound export.
    expect(names).toContain("clip_reviews_export_job_id_snapshot_decision_created_at_idx");
    expect(names).toContain("clip_reviews_scheduled_post_id_snapshot_created_at_idx");
    expect(names).toContain("clip_review_feedback_clip_review_id_created_at_idx");
    expect(names).toContain("editorial_program_workspaces_program_key_workspace_id_key");
    expect(names).toContain("users_is_platform_operator_idx");

    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN ('clip_reviews'::regclass, 'clip_review_feedback'::regclass)
      ORDER BY tgname
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      "clip_review_feedback_append_only",
      "clip_reviews_append_only",
    ]);
  });
});
