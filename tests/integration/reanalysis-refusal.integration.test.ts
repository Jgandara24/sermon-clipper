/**
 * P1.7 from the outside: the three places that ask whether a project's clips may be rebuilt, and
 * what each does when the answer is no.
 *
 * The SRT upload route answers at request time, before it writes anything. The TRANSCRIBE
 * handler refuses before it reads the override or pays for transcription. And the runner, when a
 * handler refuses, fails the job without failing the project — the clips are intact, and the
 * project must keep saying so.
 */
import {
  AuthProvider,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The same cookie mock the route-authorization matrix uses; its guard test pins the cookie name.
const cookieState = vi.hoisted(() => ({ sessionToken: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieState.sessionToken && name === "sermon_clipper_session"
        ? { name, value: cookieState.sessionToken }
        : undefined,
  }),
}));

import { POST as uploadSrt } from "@/app/api/videos/[id]/srt/route";
import { REANALYSIS_BLOCKED } from "@/lib/analysis/reanalysis-policy";
import { createSessionToken, hashSecret } from "@/lib/auth/email-otp";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import { runOnePendingJob } from "@/lib/jobs/runner";

const prisma = new PrismaClient();
const created: { workspaces: string[]; users: string[] } = { workspaces: [], users: [] };

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A workspace with one READY project, one clip, and one edit a person saved on it. */
async function seedEditedProject() {
  const user = await prisma.user.create({
    data: { email: `${unique("refusal")}@example.test`, authProvider: AuthProvider.DEV },
  });
  const sessionToken = createSessionToken();
  await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSecret(sessionToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const workspace = await prisma.workspace.create({
    data: { name: unique("refusal-ws"), owner: { connect: { id: user.id } } },
  });
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: WorkspaceRole.OWNER },
  });
  created.users.push(user.id);
  created.workspaces.push(workspace.id);

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: `${unique("refusal")}.mp4`,
      storageKey: unique("refusal-key"),
      durationS: 60,
      width: 1280,
      height: 720,
      transcript: {
        create: {
          language: "en",
          provider: "refusal-fixture",
          fullText: "peace stays with us",
          segments: {
            create: [{ idx: 0, startMs: 0, endMs: 6_000, text: "peace stays with us", words: [] }],
          },
        },
      },
    },
    include: { transcript: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: unique("refusal-project"),
      sourceVideoId: sourceVideo.id,
      status: ProjectStatus.READY,
    },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 6_000,
      title: "Peace stays",
      summary: "A clip a person has edited.",
    },
  });
  // Version 2, a person's. The machine's own first document is version 1 and does not count.
  await prisma.clipEdit.create({
    data: { clipId: clip.id, version: 2, editorState: { version: 2 }, savedBy: user.id },
  });

  return { sessionToken, workspaceId: workspace.id, sourceVideo, project, clip };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  for (const workspaceId of created.workspaces) {
    await prisma.operationalEvent.deleteMany({ where: { workspaceId } });
    await prisma.scheduledPost.deleteMany({ where: { workspaceId } });
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.sourceVideo.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  }
  await prisma.authSession.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe("the SRT upload route", () => {
  it("answers 409 before writing anything once a person has edited a clip", async () => {
    const fixture = await seedEditedProject();
    cookieState.sessionToken = fixture.sessionToken;
    try {
      const response = await uploadSrt(
        new Request(`http://test.local/api/videos/${fixture.sourceVideo.id}/srt`, {
          method: "POST",
          body: "1\n00:00:00,000 --> 00:00:06,000\npeace stays with us\n",
          headers: { "content-type": "text/plain" },
          duplex: "half",
        } as RequestInit),
        { params: Promise.resolve({ id: fixture.sourceVideo.id }) },
      );

      // Same guard the route-authorization matrix uses: a route handler's declared return type
      // allows undefined (a redirect), so narrow it before reading the response.
      if (!response) throw new Error("the SRT route returned no Response");

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(REANALYSIS_BLOCKED);
      expect(body.error.message).toMatch(/upload it as a new project/);
    } finally {
      cookieState.sessionToken = null;
    }

    // Nothing was written and nothing was queued.
    const video = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.sourceVideo.id } });
    expect(video.srtOverrideKey).toBeNull();
    const jobs = await prisma.processingJob.count({
      where: { projectId: fixture.project.id, type: ProcessingJobType.TRANSCRIBE },
    });
    expect(jobs).toBe(0);
  });
});

describe("the TRANSCRIBE handler", () => {
  it("refuses before it reads the override, and leaves the transcript as it was", async () => {
    const fixture = await seedEditedProject();
    // A key that exists nowhere: if the handler reached storage this would fail differently.
    await prisma.sourceVideo.update({
      where: { id: fixture.sourceVideo.id },
      data: { srtOverrideKey: `srt/${fixture.workspaceId}/${unique("never-written")}.srt` },
    });
    const job = await prisma.processingJob.create({
      data: {
        projectId: fixture.project.id,
        type: ProcessingJobType.TRANSCRIBE,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: unique("transcribe-refused"),
      },
    });

    await expect(
      runTranscribeJob({ job, prisma } as Parameters<typeof runTranscribeJob>[0]),
    ).rejects.toMatchObject({ code: REANALYSIS_BLOCKED, retryable: false, preservesProject: true });

    const transcript = await prisma.transcript.findUniqueOrThrow({
      where: { sourceVideoId: fixture.sourceVideo.id },
    });
    expect(transcript.id).toBe(fixture.sourceVideo.transcript?.id);
  });
});

describe("the runner, when a handler refuses", () => {
  it("fails the job and leaves the project READY with its clips", async () => {
    const fixture = await seedEditedProject();
    const job = await prisma.processingJob.create({
      data: {
        projectId: fixture.project.id,
        type: ProcessingJobType.ANALYZE,
        state: ProcessingJobState.QUEUED,
        idempotencyKey: unique("analyze-refused"),
      },
    });

    // The runner claims the globally oldest pending job; files run one at a time, so ours is
    // reached within a few claims even if an earlier file left a job behind.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
      if (current.state !== ProcessingJobState.QUEUED && current.state !== ProcessingJobState.RUNNING) break;
      if (!(await runOnePendingJob())) break;
    }

    const finished = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.state).toBe(ProcessingJobState.FAILED);
    expect(finished.errorCode).toBe(REANALYSIS_BLOCKED);

    const project = await prisma.project.findUniqueOrThrow({ where: { id: fixture.project.id } });
    expect(project.status).toBe(ProjectStatus.READY);
    const clips = await prisma.generatedClip.findMany({ where: { projectId: fixture.project.id } });
    expect(clips.map((clip) => clip.id)).toEqual([fixture.clip.id]);

    // The refusal is on the record, with the counts that caused it.
    const event = await prisma.operationalEvent.findFirst({
      where: { workspaceId: fixture.workspaceId, eventType: "processing_job_failed", jobId: job.id },
    });
    expect(event).not.toBeNull();
    expect(event?.metadata).toMatchObject({ errorCode: REANALYSIS_BLOCKED });
  });
});
