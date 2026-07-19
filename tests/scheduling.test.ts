import { describe, expect, it } from "vitest";
import {
  clearReschedulableScheduledPosts,
  scheduledDateForRank,
  slotAlreadyPublished,
} from "@/lib/scheduling";

describe("scheduledDateForRank", () => {
  const sunday = new Date("2026-07-19T00:00:00.000Z");

  it("schedules rank 1 the day after the sermon", () => {
    expect(scheduledDateForRank(sunday, 1).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("schedules rank 6 six days after a once-a-week sermon (the following Saturday)", () => {
    expect(scheduledDateForRank(sunday, 6).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("schedules rank 3 three days after a twice-a-week sermon", () => {
    const wednesday = new Date("2026-07-22T00:00:00.000Z");
    expect(scheduledDateForRank(wednesday, 3).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });
});

describe("re-analysis scheduling guards", () => {
  it("clears only NOT_STARTED/FAILED slots for the project's clips", async () => {
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
    expect(deleteWheres[0]).toEqual({
      workspaceId: "ws-1",
      clip: { projectId: "project-1" },
      publishStatus: { in: ["NOT_STARTED", "FAILED"] },
    });
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
