import { AuthProvider, GeneratedClipStatus, Prisma, WorkspaceRole } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  openTranscriptionFallbackHold,
  settleTranscriptionFallbackHold,
  TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
  transcriptProviderNameFor,
} from "@/lib/transcription/fallback-hold";
import { buildInitialEditorState } from "@/lib/editor/types";
import { INITIAL_EDIT_VERSION } from "@/lib/exports/edit-version";
import { prisma } from "@/lib/prisma";

/**
 * The hold asks one question: did a person do anything to the clips built on the fallback
 * transcript? Since ANALYZE started writing each clip's first document, the answer was always yes
 * — the machine's own row counted as somebody's work, and a healthy re-transcription could never
 * close the hold it opened.
 */

const created: string[] = [];
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

afterAll(async () => {
  for (const id of created) {
    await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

async function seedHeldProject() {
  const user = await prisma.user.create({
    data: { email: `${unique("hold")}@example.test`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: { name: unique("hold-ws"), owner: { connect: { id: user.id } } },
  });
  created.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: WorkspaceRole.OWNER },
  });
  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: "UPLOAD",
      filename: `${unique("hold")}.mp4`,
      storageKey: unique("hold-key"),
      durationS: 60,
      width: 1280,
      height: 720,
    },
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: unique("hold-project"), sourceVideoId: sourceVideo.id },
  });

  // The hold opens first, exactly as it does when the fallback transcript lands.
  await openTranscriptionFallbackHold(prisma, {
    workspaceId: workspace.id,
    projectId: project.id,
    jobId: unique("job"),
    primaryProvider: "scribe",
    usedProvider: "whisper_cpp",
    reason: "unavailable",
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 4000,
      title: "Held clip",
      hookText: "held",
      summary: "A clip built on the fallback transcript.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  return { userId: user.id, workspaceId: workspace.id, projectId: project.id, clipId: clip.id };
}

async function writeSystemInitialEdit(clipId: string, sourceVideoId = "v") {
  return prisma.clipEdit.create({
    data: {
      clipId,
      version: INITIAL_EDIT_VERSION,
      editorState: buildInitialEditorState({
        sourceVideoId,
        startMs: 0,
        endMs: 4000,
      }) as unknown as Prisma.InputJsonValue,
      savedBy: null,
    },
  });
}

const settle = (projectId: string) =>
  settleTranscriptionFallbackHold(prisma, {
    projectId,
    transcriptProvider: transcriptProviderNameFor("scribe"),
    primaryProvider: "scribe",
  });

const holdState = async (projectId: string) =>
  (
    await prisma.editorialException.findFirst({
      where: { projectId, exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE },
      select: { state: true },
    })
  )?.state;

describe("the fallback hold and system-created documents", () => {
  it("does not count a clip's initial system document as human work", async () => {
    const fixture = await seedHeldProject();
    await writeSystemInitialEdit(fixture.clipId);

    const outcome = await settle(fixture.projectId);

    expect(outcome).toEqual({ settled: "resolved" });
    expect(await holdState(fixture.projectId)).toBe("RESOLVED");
  });

  it("resolves a healthy rebuild when nobody edited, approved or exported", async () => {
    const fixture = await seedHeldProject();
    await writeSystemInitialEdit(fixture.clipId);
    // A second clip, because ANALYZE writes one of these per clip.
    const second = await prisma.generatedClip.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        rank: 2,
        startMs: 4000,
        endMs: 8000,
        title: "Second held clip",
        hookText: "second",
        summary: "A second clip built on the fallback transcript.",
        status: GeneratedClipStatus.SUGGESTED,
      },
    });
    await writeSystemInitialEdit(second.id);

    expect(await settle(fixture.projectId)).toEqual({ settled: "resolved" });
  });

  it("still keeps the hold open when a person edited a clip", async () => {
    const fixture = await seedHeldProject();
    await writeSystemInitialEdit(fixture.clipId);
    // A real save: signed, and a version above the initial one.
    await prisma.clipEdit.create({
      data: {
        clipId: fixture.clipId,
        version: INITIAL_EDIT_VERSION + 1,
        editorState: buildInitialEditorState({
          sourceVideoId: "v",
          startMs: 0,
          endMs: 4000,
        }) as unknown as Prisma.InputJsonValue,
        savedBy: fixture.userId,
      },
    });

    const outcome = await settle(fixture.projectId);

    expect(outcome).toEqual({
      settled: "kept_open",
      reason: "human_work_needs_reconciliation",
    });
    expect(await holdState(fixture.projectId)).toBe("OPEN");
  });
});

describe("the initial document's version", () => {
  it("stores the same version inside the document as on the row", async () => {
    const fixture = await seedHeldProject();
    const row = await writeSystemInitialEdit(fixture.clipId);
    const state = row.editorState as unknown as { version: number };

    expect(row.version).toBe(INITIAL_EDIT_VERSION);
    expect(state.version, "the document disagrees with its own row").toBe(INITIAL_EDIT_VERSION);
  });
});
