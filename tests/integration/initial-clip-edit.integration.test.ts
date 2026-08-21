import {
  AuthProvider,
  ProcessingJobState,
  ProcessingJobType,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { runAnalyzeJob } from "@/lib/jobs/handlers/analyze";
import { buildDefaultEditorState } from "@/lib/editor/types";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import type { EditorState } from "@/lib/editor/types";
import { prisma } from "@/lib/prisma";

/**
 * Uppercase for new content, without touching what already exists.
 *
 * ANALYZE is the one production path that creates a generated clip, so it is the only place that
 * can tell a new clip from an old one. It writes the clip's initial document; a clip that predates
 * this has no document at all and keeps falling back to the preset's case, exactly as before.
 */

const SEGMENT_MS = 6_000;
const created: { users: string[]; workspaces: string[] } = { users: [], workspaces: [] };

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

afterAll(async () => {
  for (const id of created.workspaces) {
    await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of created.users) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

function segmentsFor(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    idx,
    startMs: idx * SEGMENT_MS,
    endMs: (idx + 1) * SEGMENT_MS,
    text:
      "Jesus tells the church that peace stays with us, so do not let your hearts be troubled " +
      "today, and pray with hope and grace for one another in this season of waiting.",
  }));
}

async function analyzeOneProject() {
  const user = await prisma.user.create({
    data: { email: `${unique("initial")}@example.test`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: { name: unique("initial-ws"), owner: { connect: { id: user.id } } },
  });
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: WorkspaceRole.OWNER },
  });
  created.users.push(user.id);
  created.workspaces.push(workspace.id);

  const segmentCount = 40;
  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: `${unique("initial")}.mp4`,
      storageKey: unique("initial-key"),
      durationS: (segmentCount * SEGMENT_MS) / 1000,
      width: 1280,
      height: 720,
      transcript: {
        create: {
          language: "en",
          provider: "initial-fixture",
          fullText: "initial fixture transcript",
          segments: { create: segmentsFor(segmentCount) },
        },
      },
    },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: unique("initial-project"),
      sourceVideoId: sourceVideo.id,
      sermonDate: null,
    },
  });
  const job = await prisma.processingJob.create({
    data: {
      projectId: project.id,
      type: ProcessingJobType.ANALYZE,
      state: ProcessingJobState.RUNNING,
      idempotencyKey: unique("initial-job"),
    },
  });

  await runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);

  const clips = await prisma.generatedClip.findMany({
    where: { projectId: project.id },
    orderBy: { rank: "asc" },
  });
  return { workspaceId: workspace.id, projectId: project.id, clips };
}

describe("the initial clip document", () => {
  it("gives a newly generated clip a persisted Uppercase document", async () => {
    const { clips } = await analyzeOneProject();
    expect(clips.length).toBeGreaterThan(0);

    for (const clip of clips) {
      const edit = await prisma.clipEdit.findFirst({
        where: { clipId: clip.id },
        orderBy: { version: "desc" },
      });
      expect(edit, `clip ${clip.rank} has no initial document`).not.toBeNull();
      const state = edit!.editorState as unknown as EditorState;
      expect(state.captions.overrides.textCase).toBe("uppercase");
      // System-created, so nobody signed it.
      expect(edit!.savedBy).toBeNull();
    }
  }, 60_000);

  it("renders that persisted document in Uppercase, which is what export and the editor read", async () => {
    const { clips } = await analyzeOneProject();
    const edit = await prisma.clipEdit.findFirst({
      where: { clipId: clips[0].id },
      orderBy: { version: "desc" },
    });
    const state = edit!.editorState as unknown as EditorState;
    // Both the export route and the editor page load the newest ClipEdit and use it as-is.
    expect(resolveCaptionStyle(state.captions.presetId, state.captions.overrides).textCase).toBe(
      "uppercase",
    );
  }, 60_000);

  it("leaves an existing clip with no document on the old fallback", async () => {
    // A clip that predates this change has no ClipEdit at all. Export and the editor build the
    // default document for it, and that document must still carry no case.
    const fallback = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 1000 });
    expect(fallback.captions.overrides.textCase).toBeUndefined();
    expect(
      resolveCaptionStyle(fallback.captions.presetId, fallback.captions.overrides).textCase,
    ).toBe("original");
  });
});
