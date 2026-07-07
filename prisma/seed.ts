import {
  AuthProvider,
  ClipApprovalState,
  GeneratedClipStatus,
  LedgerKind,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";

const prisma = new PrismaClient();
const demoEmail = "demo@sermonclipper.local";

async function main() {
  const user = await prisma.user.upsert({
    where: { email: demoEmail },
    update: { name: "Demo Volunteer" },
    create: {
      email: demoEmail,
      name: "Demo Volunteer",
      authProvider: AuthProvider.DEV,
    },
  });

  const existingWorkspace = await prisma.workspace.findFirst({
    where: { ownerId: user.id, name: "First Baptist Demo" },
  });

  const workspace =
    existingWorkspace ??
    (await prisma.workspace.create({
      data: {
        name: "First Baptist Demo",
        ownerId: user.id,
        planCode: "dev",
        minuteBalance: 60,
        settings: {
          churchProfile: {
            timezone: "America/Chicago",
            serviceDay: "Sunday",
          },
          defaultProcessingConfig: {
            language: "en",
            clipLength: "60-89s",
            genre: "sermon",
          },
        },
      },
    }));

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id,
      },
    },
    update: { role: WorkspaceRole.OWNER },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: WorkspaceRole.OWNER,
    },
  });

  const sourceVideo =
    (await prisma.sourceVideo.findFirst({
      where: { workspaceId: workspace.id, filename: "demo-sermon-clipper-fixture.mp4" },
    })) ??
    (await prisma.sourceVideo.create({
      data: {
        workspaceId: workspace.id,
        origin: SourceOrigin.UPLOAD,
        filename: "demo-sermon-clipper-fixture.mp4",
        durationS: new Prisma.Decimal("180.00"),
        sizeBytes: BigInt(73400320),
        width: 1920,
        height: 1080,
        fps: new Prisma.Decimal("29.970"),
        language: "en",
        storageKey: "fixtures/demo-sermon-clipper-fixture.mp4",
        thumbnailKey: "fixtures/demo-sermon-clipper-thumb.jpg",
        copyrightAckAt: new Date("2026-07-05T18:00:00.000Z"),
      },
    }));

  const project =
    (await prisma.project.findFirst({
      where: { workspaceId: workspace.id, name: "Sunday Message Demo" },
    })) ??
    (await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        sourceVideoId: sourceVideo.id,
        name: "Sunday Message Demo",
        status: ProjectStatus.DRAFT,
        series: "Foundation",
        speaker: "Pastor Demo",
        processingConfig: {
          language: "en",
          lengthBucket: "60-89s",
          timeframe: { startS: 0, endS: 180 },
          genre: "sermon",
          mode: "clip",
          phase: "phase-1-stub",
        },
      },
    }));

  await prisma.processingJob.upsert({
    where: { idempotencyKey: `phase1:${project.id}:probe-stub` },
    update: { state: ProcessingJobState.WAITING },
    create: {
      projectId: project.id,
      type: ProcessingJobType.PROBE,
      state: ProcessingJobState.WAITING,
      progress: 0,
      attempt: 0,
      idempotencyKey: `phase1:${project.id}:probe-stub`,
      errorMessageUser: "Video processing is intentionally stubbed in Phase 1.",
      minutesReserved: new Prisma.Decimal("0.00"),
    },
  });

  const existingClip = await prisma.generatedClip.findFirst({
    where: { projectId: project.id, rank: 1 },
  });

  const clip =
    existingClip ??
    (await prisma.generatedClip.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        rank: 1,
        startMs: 12000,
        endMs: 54000,
        title: "A Steady Word For Anxious People",
        hookText: "Peace has a source",
        summary:
          "A self-contained sermon moment that connects anxiety, trust, and the text without needing the full message.",
        status: GeneratedClipStatus.SUGGESTED,
      },
    }));

  await prisma.clipScore.upsert({
    where: { clipId: clip.id },
    update: { total: 87 },
    create: {
      workspaceId: workspace.id,
      clipId: clip.id,
      total: 87,
      modelVersion: "seed-phase-1",
      excerpt: "The peace Jesus gives is not borrowed from better circumstances.",
      subscores: {
        clarity: { score: 88, letter: "A", note: "The thought stands on its own." },
        biblical_usefulness: {
          score: 90,
          letter: "A",
          note: "The point is tied to the message of the text.",
        },
        emotional_impact: {
          score: 84,
          letter: "B+",
          note: "The moment speaks to a common pastoral burden.",
        },
        completeness: {
          score: 86,
          letter: "A-",
          note: "The clip resolves cleanly.",
        },
        shareability: {
          score: 86,
          letter: "A-",
          note: "A church member could send this to someone carrying anxiety.",
        },
      },
    },
  });

  await prisma.scriptureReference.deleteMany({ where: { clipId: clip.id } });
  await prisma.scriptureReference.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      clipId: clip.id,
      detectedText: "John 14",
      normalized: "John 14",
      book: "John",
      chapterStart: 14,
      confidence: new Prisma.Decimal("0.80"),
    },
  });

  await prisma.brandTemplate.upsert({
    where: { id: "00000000-0000-0000-0000-000000000010" },
    update: {
      workspaceId: workspace.id,
      name: "Sunday Sermon",
      churchName: workspace.name,
      speakerName: "Pastor",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      captionPresetId: "clean",
      lowerThird: { headline: workspace.name, subhead: "Sunday message", showSpeaker: true },
      isDefault: true,
    },
    create: {
      id: "00000000-0000-0000-0000-000000000010",
      workspaceId: workspace.id,
      name: "Sunday Sermon",
      churchName: workspace.name,
      speakerName: "Pastor",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      captionPresetId: "clean",
      lowerThird: { headline: workspace.name, subhead: "Sunday message", showSpeaker: true },
      isDefault: true,
    },
  });

  await prisma.clipApproval.upsert({
    where: { clipId: clip.id },
    update: {
      state: ClipApprovalState.IN_REVIEW,
      requesterId: user.id,
    },
    create: {
      workspaceId: workspace.id,
      clipId: clip.id,
      requesterId: user.id,
      state: ClipApprovalState.IN_REVIEW,
      reviewToken: "demo-review-token-sermon-clipper-phase-7",
    },
  });

  await prisma.usageLedger.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: { balanceAfter: new Prisma.Decimal("60.00") },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      workspaceId: workspace.id,
      projectId: project.id,
      kind: LedgerKind.GRANT,
      minutesDelta: new Prisma.Decimal("60.00"),
      balanceAfter: new Prisma.Decimal("60.00"),
      note: "Seeded Phase 1 development balance.",
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
