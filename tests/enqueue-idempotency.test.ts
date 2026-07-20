import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { enqueueExportJob } from "@/lib/exports/queue";

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

describe("enqueueJob idempotency race", () => {
  it("returns the winner's row when a concurrent enqueue loses the create race", async () => {
    const existingJob = { id: "job-1", idempotencyKey: "probe:project-1" };
    let findCalls = 0;
    const client = {
      processingJob: {
        // First read (fast path) sees nothing — the concurrent winner commits in between.
        findUnique: async () => {
          findCalls += 1;
          return null;
        },
        create: async () => {
          throw p2002();
        },
        findUniqueOrThrow: async () => existingJob,
      },
    };

    const result = await enqueueJob(client as never, {
      projectId: "project-1",
      type: "PROBE" as never,
      idempotencyKey: "probe:project-1",
    });

    expect(result).toBe(existingJob);
    expect(findCalls).toBe(1);
  });

  it("rethrows non-P2002 create errors", async () => {
    const client = {
      processingJob: {
        findUnique: async () => null,
        create: async () => {
          throw new Error("connection lost");
        },
        findUniqueOrThrow: async () => {
          throw new Error("should not be called");
        },
      },
    };

    await expect(
      enqueueJob(client as never, {
        projectId: "project-1",
        type: "PROBE" as never,
        idempotencyKey: "probe:project-1",
      }),
    ).rejects.toThrow("connection lost");
  });
});

describe("enqueueExportJob idempotency race", () => {
  it("returns the winner's row when a concurrent enqueue loses the create race", async () => {
    const existingJob = { id: "export-1", idempotencyKey: "export:clip-1" };
    const client = {
      exportJob: {
        findUnique: async () => null,
        create: async () => {
          throw p2002();
        },
        findUniqueOrThrow: async () => existingJob,
      },
    };

    const result = await enqueueExportJob(client as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "clip.mp4",
      idempotencyKey: "export:clip-1",
    });

    expect(result).toBe(existingJob);
  });
});
