import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
vi.mock("@/lib/prisma", () => ({ prisma: {
  generatedClip: { findUnique: vi.fn() }, clipEdit: { findFirst: vi.fn() },
  clipApproval: { findUnique: vi.fn() }, $transaction: vi.fn(),
} }));
vi.mock("@/lib/api/auth", () => ({ requireApiWorkspace: vi.fn(async () => ({
  user: { id: "synthetic-user" }, workspace: { id: "synthetic-workspace" },
})) }));
vi.mock("@/lib/project-service", () => ({ assertWorkspaceScope: (a: string, b: string) => {
  if (a !== b) throw new Error("wrong workspace");
} }));
import { prisma } from "@/lib/prisma";
import { GET, PUT } from "@/app/api/clips/[id]/edit-state/route";
import { ClipTranscriptChangedError } from "@/lib/analysis/source-write-boundary";
import { fixture } from "./fixtures";

function setup(duration = 152000) {
  const f = fixture(duration);
  const saved = { version: 3, editorState: structuredClone(f.state) };
  const clip = { id: "synthetic-clip", workspaceId: "synthetic-workspace",
    startMs: f.state.source.startMs, endMs: f.state.source.endMs,
    project: { processingConfig: f.processingConfig, sourceVideo: {
      id: f.source!.id, durationS: new Prisma.Decimal(f.source!.durationMs! / 1000),
    } },
  };
  const tx = {
    clipEdit: { create: vi.fn(async ({ data }: { data: { version: number; editorState: unknown } }) => data) },
    clipApproval: { updateMany: vi.fn(async () => ({ count: 1 })) },
    clipApprovalAuditEvent: { create: vi.fn(async () => ({})) },
  };
  vi.mocked(prisma.generatedClip.findUnique).mockResolvedValue(clip as never);
  vi.mocked(prisma.clipEdit.findFirst).mockResolvedValue(saved as never);
  vi.mocked(prisma.clipApproval.findUnique).mockResolvedValue({ id: "approval", workspaceId: clip.workspaceId, state: "APPROVED" } as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: unknown) =>
    (callback as (client: typeof tx) => Promise<unknown>)(tx));
  const context = { params: Promise.resolve({ id: clip.id }) };
  const save = (baseVersion = 3, isAutosave = false) => PUT(new Request("http://localhost/edit", {
    method: "PUT", body: JSON.stringify({ baseVersion, state: f.state, isAutosave }),
  }), context);
  return { f, clip, saved, tx, save, context };
}

beforeEach(() => vi.resetAllMocks());
describe("policy-aware editor saves with mocked persistence", () => {
  it.each([3000, 19999, 103000, 152000, 180001, 300000])("saves %i ms without truncation", async (duration) => {
    const { f, tx, save, saved } = setup(duration);
    f.state.systemInitial = true;
    f.state.wordEdits.textOverrides = [{ wordId: "invented:0", text: "Corrected" }];
    const before = structuredClone(saved);
    const response = await save();
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.data.version).toBe(4);
    expect(body.data.state.source).toEqual(f.state.source);
    expect(body.data.state.wordEdits).toEqual(f.state.wordEdits);
    expect(body.data.state.systemInitial).toBeUndefined();
    expect(body.data.approvalState).toBe("DRAFT");
    expect(tx.clipEdit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ savedBy: "synthetic-user", version: 4 }) });
    expect(tx.clipApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { clipId: "synthetic-clip", state: "APPROVED" },
      data: expect.objectContaining({ state: "DRAFT", reviewTokenRevokedAt: expect.any(Date) }),
    }));
    expect(tx.clipApprovalAuditEvent.create).toHaveBeenCalledOnce();
    expect(saved).toEqual(before);
  });
  it("preserves old saved documents when the policy is disabled", async () => {
    const { clip, saved, context } = setup(300000);
    clip.project.processingConfig = { completeMessagePolicy: { enabled: false } };
    const response = await GET(new Request("http://localhost/edit"), context);
    expect((await response!.json()).data).toEqual({ version: saved.version, state: saved.editorState });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([undefined, { completeMessagePolicy: { enabled: false } }])("retains disabled save behavior", async (config) => {
    const { clip, f, save } = setup(300000);
    clip.project.processingConfig = config;
    f.state.source.videoId = "legacy-identity";
    expect((await save())!.status).toBe(200);
  });
  it.each(["bounds", "identity", "duration", "policy"])("refuses %s before writes", async (kind) => {
    const { clip, f, save } = setup();
    if (kind === "bounds") f.state.source.endMs = f.source!.durationMs! + 1;
    if (kind === "identity") f.state.source.videoId = "different-source";
    if (kind === "duration") clip.project.sourceVideo.durationS = new Prisma.Decimal(0);
    if (kind === "policy") clip.project.processingConfig = { completeMessagePolicy: { enabled: true } };
    expect((await save())!.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("refuses a stale base version without revoking approval", async () => {
    const { save, tx } = setup();
    expect((await save(2))!.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.clipApproval.updateMany).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves insert-race protection for autosave=%s", async (autosave) => {
    const { save } = setup();
    vi.mocked(prisma.$transaction).mockRejectedValue(new Prisma.PrismaClientKnownRequestError("synthetic conflict", {
      code: "P2002", clientVersion: "test",
    }));
    const response = await save(3, autosave);
    expect(response!.status).toBe(409);
    expect((await response!.json()).error.code).toBe("EDIT_STATE_CONFLICT");
  });
  it("preserves transcript-change protection", async () => {
    const { save } = setup();
    vi.mocked(prisma.$transaction).mockRejectedValue(new ClipTranscriptChangedError());
    const response = await save();
    expect(response!.status).toBe(409);
    expect((await response!.json()).error.code).toBe("CLIP_TRANSCRIPT_CHANGED");
  });
  it("retains workspace checks", async () => {
    const { clip, save } = setup();
    clip.workspaceId = "different-workspace";
    expect((await save())!.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
