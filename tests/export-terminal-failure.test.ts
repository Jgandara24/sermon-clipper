import { ProcessingJobState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { markExportJobFailedOrRetry } from "@/lib/exports/queue";
import { EXPORT_MAX_ATTEMPTS } from "@/lib/worker/reliability";

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

describe("markExportJobFailedOrRetry terminal failures", () => {
  function updateManyClient() {
    const updateMany = vi.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>(() =>
      Promise.resolve({ count: 1 }),
    );
    return { client: { exportJob: { updateMany } }, updateMany };
  }

  const runningJob = {
    id: "export-1",
    attempt: 1,
    state: ProcessingJobState.RUNNING,
  } as never;

  it("fails a deterministic version error outright instead of scheduling another render", async () => {
    const { client, updateMany } = updateManyClient();

    const outcome = await markExportJobFailedOrRetry(client as never, runningJob, {
      code: "EXPORT_EDIT_VERSION_NOT_FOUND",
      message: "That saved version is no longer available.",
      terminal: true,
    });

    expect(outcome).toBe("FAILED");
    const data = updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.state).toBe(ProcessingJobState.FAILED);
    expect(data.runAfter).toBeUndefined();
  });

  it("still retries a transient failure with attempts remaining", async () => {
    const { client, updateMany } = updateManyClient();

    const outcome = await markExportJobFailedOrRetry(client as never, runningJob, {
      code: "RENDER_FAILED",
      message: "Export failed on our side — your clip is safe.",
    });

    expect(outcome).toBe("RETRYING");
    const data = updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.state).toBe(ProcessingJobState.RETRYING);
    expect(data.runAfter).toBeInstanceOf(Date);
  });

  it("fails a transient failure once attempts are exhausted", async () => {
    const { client, updateMany } = updateManyClient();

    const outcome = await markExportJobFailedOrRetry(
      client as never,
      { id: "export-1", attempt: EXPORT_MAX_ATTEMPTS } as never,
      { code: "RENDER_FAILED", message: "Export failed on our side — your clip is safe." },
    );

    expect(outcome).toBe("FAILED");
    expect((updateMany.mock.calls[0][0].data as Record<string, unknown>).state).toBe(
      ProcessingJobState.FAILED,
    );
  });
});
