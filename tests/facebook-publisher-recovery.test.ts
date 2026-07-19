import { describe, expect, it } from "vitest";
import { recoverStaleScheduledPosts } from "@/lib/integrations/facebook-publisher";

type FakeRow = {
  id: string;
  workspaceId: string;
  publishStatus: string;
  attemptCount: number;
  updatedAt: Date;
  nextAttemptAt: Date | null;
  lastErrorMessage: string | null;
};

function makeFakeClient(rows: FakeRow[]) {
  const matchesStale = (row: FakeRow, where: { publishStatus: string; updatedAt: { lt: Date } }) =>
    row.publishStatus === where.publishStatus && row.updatedAt.getTime() < where.updatedAt.lt.getTime();

  const client = {
    scheduledPost: {
      findMany: async ({ where }: { where: { publishStatus: string; updatedAt: { lt: Date } } }) =>
        rows.filter((row) => matchesStale(row, where)),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; publishStatus: string; updatedAt: { lt: Date } };
        data: Partial<FakeRow>;
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row || !matchesStale(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    operationalEvent: { create: async () => ({}) },
  };
  return client as never;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "post-1",
    workspaceId: "ws-1",
    publishStatus: "IN_PROGRESS",
    attemptCount: 0,
    updatedAt: new Date("2026-07-20T14:00:00Z"),
    nextAttemptAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

const now = new Date("2026-07-20T15:00:00Z");

describe("recoverStaleScheduledPosts", () => {
  it("re-queues a stale IN_PROGRESS claim and counts the attempt", async () => {
    const row = makeRow({ updatedAt: new Date("2026-07-20T14:30:00Z") });
    const result = await recoverStaleScheduledPosts(makeFakeClient([row]), now);

    expect(result).toEqual({ recovered: 1, failed: 0 });
    expect(row.publishStatus).toBe("NOT_STARTED");
    expect(row.attemptCount).toBe(1);
    expect(row.lastErrorMessage).toContain("re-queued");
  });

  it("leaves a fresh IN_PROGRESS claim untouched", async () => {
    const row = makeRow({ updatedAt: new Date("2026-07-20T14:50:00Z") });
    const result = await recoverStaleScheduledPosts(makeFakeClient([row]), now);

    expect(result).toEqual({ recovered: 0, failed: 0 });
    expect(row.publishStatus).toBe("IN_PROGRESS");
    expect(row.attemptCount).toBe(0);
  });

  it("fails a poison post terminally once attempts are exhausted", async () => {
    const row = makeRow({ attemptCount: 4, updatedAt: new Date("2026-07-20T14:00:00Z") });
    const result = await recoverStaleScheduledPosts(makeFakeClient([row]), now);

    expect(result).toEqual({ recovered: 0, failed: 1 });
    expect(row.publishStatus).toBe("FAILED");
    expect(row.attemptCount).toBe(5);
  });
});
