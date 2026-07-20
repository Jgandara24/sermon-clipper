import { describe, expect, it, vi, type Mock } from "vitest";
import { Prisma } from "@prisma/client";
import { buildDefaultEditorState } from "@/lib/editor/types";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    generatedClip: { findUnique: vi.fn() },
    clipEdit: { findFirst: vi.fn() },
    clipApproval: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/api/auth", () => ({
  requireApiWorkspace: vi.fn(async () => ({
    user: { id: "user-1" },
    workspace: { id: "ws-1" },
  })),
}));

import { prisma } from "@/lib/prisma";
import { PUT } from "@/app/api/clips/[id]/edit-state/route";

function putRequest(body: unknown) {
  return new Request("http://localhost/api/clips/clip-1/edit-state", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("edit-state PUT concurrency", () => {
  it("returns the EDIT_STATE_CONFLICT 409 when the version insert races (P2002)", async () => {
    (prisma.generatedClip.findUnique as Mock).mockResolvedValue({
      id: "clip-1",
      workspaceId: "ws-1",
      startMs: 0,
      endMs: 10_000,
      project: { sourceVideo: { id: "sv-1" } },
    });
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (prisma.clipApproval.findUnique as Mock).mockResolvedValue(null);
    // Both saves passed the version check; the loser's insert hits @@unique([clipId, version]).
    (prisma.$transaction as Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const state = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 0, endMs: 10_000 });
    const response = await PUT(putRequest({ baseVersion: 3, state, isAutosave: true }), {
      params: Promise.resolve({ id: "clip-1" }),
    });
    if (!response) throw new Error("expected a response");

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("EDIT_STATE_CONFLICT");
  });

  it("rethrows non-P2002 transaction errors", async () => {
    (prisma.generatedClip.findUnique as Mock).mockResolvedValue({
      id: "clip-1",
      workspaceId: "ws-1",
      startMs: 0,
      endMs: 10_000,
      project: { sourceVideo: { id: "sv-1" } },
    });
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (prisma.clipApproval.findUnique as Mock).mockResolvedValue(null);
    (prisma.$transaction as Mock).mockRejectedValue(new Error("connection lost"));

    const state = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 0, endMs: 10_000 });
    await expect(
      PUT(putRequest({ baseVersion: 3, state }), { params: Promise.resolve({ id: "clip-1" }) }),
    ).rejects.toThrow("connection lost");
  });
});
