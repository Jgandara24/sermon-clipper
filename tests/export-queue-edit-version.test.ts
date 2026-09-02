import { ProcessingJobState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { parseExportIdempotencyKeyVersion } from "@/lib/exports/edit-version";
import { enqueueExportJob, requeueFailedExportJob } from "@/lib/exports/queue";

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function createCapturingClient() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "export-1", ...data }));
  return {
    client: { exportJob: { findUnique: vi.fn(async () => null), create, findUniqueOrThrow: vi.fn() } },
    create,
  };
}

describe("enqueueExportJob edit-version pinning", () => {
  it("stores the requested edit version on the job row", async () => {
    const { client, create } = createCapturingClient();

    const job = await enqueueExportJob(client as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "sermon.mp4",
      editVersion: 2,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.editVersion).toBe(2);
    expect((job as unknown as { editVersion: number }).editVersion).toBe(2);
  });

  it("stores version 0 for a clip that has never been edited", async () => {
    const { client, create } = createCapturingClient();

    await enqueueExportJob(client as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "sermon.mp4",
      editVersion: 0,
    });

    expect(create.mock.calls[0][0].data.editVersion).toBe(0);
  });

  it("derives the idempotency key from the same version it stores", async () => {
    for (const editVersion of [0, 1, 9, 137]) {
      const { client, create } = createCapturingClient();

      await enqueueExportJob(client as never, {
        clipId: "clip-1",
        workspaceId: "ws-1",
        filename: "series: part 2.mp4",
        editVersion,
      });

      const data = create.mock.calls[0][0].data as { editVersion: number; idempotencyKey: string };
      expect(parseExportIdempotencyKeyVersion(data.idempotencyKey)).toBe(data.editVersion);
      expect(data.editVersion).toBe(editVersion);
    }
  });

  it("keeps the filename out of the identity while still storing it on the row", async () => {
    const { client, create } = createCapturingClient();

    await enqueueExportJob(client as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "series: part 2.mp4",
      editVersion: 4,
    });

    const data = create.mock.calls[0][0].data as { idempotencyKey: string; filename: string };
    expect(data.idempotencyKey).toBe("export:clip-1:v4");
    expect(data.filename).toBe("series: part 2.mp4");
  });

  it("looks one identity up however the file is named", async () => {
    // Two requests that would render identical pixels are one piece of work. The filename names
    // the download, so it must not be able to mint a second render (P1.2).
    const keys: string[] = [];
    for (const filename of ["sermon.mp4", "sermon-renamed.mp4", "grace-20260902.mp4"]) {
      const findUnique = vi.fn(async () => null);
      const client = {
        exportJob: { findUnique, create: vi.fn(async () => ({ id: "export-1" })), findUniqueOrThrow: vi.fn() },
      };
      await enqueueExportJob(client as never, {
        clipId: "clip-1",
        workspaceId: "ws-1",
        filename,
        editVersion: 5,
      });
      const calls = findUnique.mock.calls as unknown as Array<[{ where: { idempotencyKey: string } }]>;
      keys.push(calls[0][0].where.idempotencyKey);
    }

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("export:clip-1:v5");
  });

  it("gives a different edit version its own identity", async () => {
    const { client: clientA, create: createA } = createCapturingClient();
    const { client: clientB, create: createB } = createCapturingClient();

    await enqueueExportJob(clientA as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "same-name.mp4",
      editVersion: 5,
    });
    await enqueueExportJob(clientB as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "same-name.mp4",
      editVersion: 6,
    });

    expect((createA.mock.calls[0][0].data as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (createB.mock.calls[0][0].data as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it("reuses the existing row for a repeated request of the same clip and version", async () => {
    const existing = { id: "export-1", editVersion: 3 };
    const client = {
      exportJob: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    };

    const job = await enqueueExportJob(client as never, {
      clipId: "clip-1",
      workspaceId: "ws-1",
      filename: "sermon.mp4",
      editVersion: 3,
    });

    expect(job).toBe(existing);
    expect(client.exportJob.create).not.toHaveBeenCalled();
  });
});

describe("requeueFailedExportJob", () => {
  it("never rewrites the pinned edit version when a user retries", async () => {
    const updateMany = vi.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>(() =>
      Promise.resolve({ count: 1 }),
    );

    await requeueFailedExportJob({ exportJob: { updateMany } } as never, "export-1");

    const call = updateMany.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("editVersion");
    expect(call.data).not.toHaveProperty("idempotencyKey");
    expect(call.where.state).toBe(ProcessingJobState.FAILED);
  });
});
