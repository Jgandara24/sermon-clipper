import { describe, expect, it } from "vitest";
import {
  clearReschedulableScheduledPosts,
  findScheduledPostCollision,
  slotAlreadyPublished,
} from "@/lib/scheduling";


describe("re-analysis scheduling guards", () => {
  it("clears every reschedulable slot the project owns, by clip or by project", async () => {
    const deleteWheres: Array<Record<string, unknown>> = [];
    const tx = {
      scheduledPost: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          deleteWheres.push(where);
          return { count: 2 };
        },
        findFirst: async () => null,
      },
    };

    const result = await clearReschedulableScheduledPosts(tx, {
      workspaceId: "ws-1",
      projectId: "project-1",
    });

    expect(result.count).toBe(2);
    // MISSED and UNFILLED are cleared too (P1.9): neither reached an audience, and leaving them
    // is what would detach them from a rebuilt clip. The OR matches an UNFILLED row, which has
    // no clip to match through.
    expect(deleteWheres[0]).toEqual({
      workspaceId: "ws-1",
      OR: [{ clip: { projectId: "project-1" } }, { projectId: "project-1" }],
      publishStatus: { in: ["NOT_STARTED", "FAILED", "MISSED", "UNFILLED"] },
    });
  });

  it("treats any earlier row on the workspace date as a collision", async () => {
    const scheduledDate = new Date("2026-07-21T00:00:00.000Z");
    const tx = {
      scheduledPost: {
        deleteMany: async () => ({ count: 0 }),
        findFirst: async () => ({
          id: "earlier-post",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          publishStatus: "FAILED" as const,
          clip: { projectId: "earlier-project" },
        }),
      },
    };

    await expect(
      findScheduledPostCollision(tx, { workspaceId: "ws-1", scheduledDate }),
    ).resolves.toMatchObject({
      id: "earlier-post",
      publishStatus: "FAILED",
      projectId: "earlier-project",
    });
  });

  it("returns no collision when the workspace date is free", async () => {
    const tx = {
      scheduledPost: {
        deleteMany: async () => ({ count: 0 }),
        findFirst: async () => null,
      },
    };
    await expect(
      findScheduledPostCollision(tx, {
        workspaceId: "ws-1",
        scheduledDate: new Date("2026-07-22T00:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("reports a slot as published only when a SUCCEEDED/IN_PROGRESS row exists", async () => {
    const scheduledDate = new Date("2026-07-21T00:00:00.000Z");
    const findWheres: Array<Record<string, unknown>> = [];
    const makeTx = (hit: boolean) => ({
      scheduledPost: {
        deleteMany: async () => ({ count: 0 }),
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          findWheres.push(where);
          return hit ? { id: "existing-post" } : null;
        },
      },
    });

    expect(await slotAlreadyPublished(makeTx(true), { workspaceId: "ws-1", scheduledDate })).toBe(true);
    expect(await slotAlreadyPublished(makeTx(false), { workspaceId: "ws-1", scheduledDate })).toBe(false);
    expect(findWheres[0]).toEqual({
      workspaceId: "ws-1",
      scheduledDate,
      publishStatus: { in: ["SUCCEEDED", "IN_PROGRESS"] },
    });
  });
});
