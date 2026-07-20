import { describe, expect, it, vi } from "vitest";
import { ProcessingJobState } from "@prisma/client";
import { cancelJobIfActive, markJobFailed, markJobFailedOrRetry, markJobSucceeded } from "@/lib/jobs/queue";
import { markExportJobFailedOrRetry, markExportJobSucceeded } from "@/lib/exports/queue";
import { HeartbeatLostError, withHeartbeat } from "@/lib/worker/reliability";

type FakeJobRow = {
  id: string;
  state: ProcessingJobState;
  attempt: number;
  maxAttempts: number;
  [key: string]: unknown;
};

function makeJob(overrides: Partial<FakeJobRow> = {}): FakeJobRow {
  return {
    id: "job-1",
    state: ProcessingJobState.RUNNING,
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

/** In-memory single-row table honoring the {id, state} / {id, state: {in}} where shapes the queue uses. */
function makeFakeTable(row: FakeJobRow) {
  const matches = (where: Record<string, unknown>) => {
    if (where.id !== undefined && where.id !== row.id) return false;
    const state = where.state as ProcessingJobState | { in: ProcessingJobState[] } | undefined;
    if (state !== undefined) {
      if (typeof state === "object" && "in" in state) {
        if (!state.in.includes(row.state)) return false;
      } else if (state !== row.state) {
        return false;
      }
    }
    return true;
  };
  return {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
}

function makeProcessingClient(row: FakeJobRow) {
  return { processingJob: makeFakeTable(row) } as never;
}

function makeExportClient(row: FakeJobRow) {
  return { exportJob: makeFakeTable(row) } as never;
}

describe("terminal job transitions never overwrite a concurrent cancel/recovery", () => {
  it("marks a still-running job succeeded", async () => {
    const row = makeJob();
    expect(await markJobSucceeded(makeProcessingClient(row), row.id)).toBe(true);
    expect(row.state).toBe(ProcessingJobState.SUCCEEDED);
  });

  it("cancel-then-succeed leaves the job CANCELED", async () => {
    const row = makeJob();
    const client = makeProcessingClient(row);
    await cancelJobIfActive(client, row.id);
    expect(row.state).toBe(ProcessingJobState.CANCELED);

    expect(await markJobSucceeded(client, row.id)).toBe(false);
    expect(row.state).toBe(ProcessingJobState.CANCELED);
  });

  it("cancel-then-fail leaves the job CANCELED (retry branch)", async () => {
    const row = makeJob({ attempt: 1, maxAttempts: 3 });
    const client = makeProcessingClient(row);
    await cancelJobIfActive(client, row.id);

    const outcome = await markJobFailedOrRetry(client, row as never, {
      code: "TEST_FAILURE",
      message: "boom",
    });
    expect(outcome).toBe("SKIPPED");
    expect(row.state).toBe(ProcessingJobState.CANCELED);
  });

  it("cancel-then-fail leaves the job CANCELED (exhausted branch)", async () => {
    const row = makeJob({ attempt: 3, maxAttempts: 3 });
    const client = makeProcessingClient(row);
    await cancelJobIfActive(client, row.id);

    const outcome = await markJobFailedOrRetry(client, row as never, {
      code: "TEST_FAILURE",
      message: "boom",
    });
    expect(outcome).toBe("SKIPPED");
    expect(row.state).toBe(ProcessingJobState.CANCELED);
    expect(await markJobFailed(client, row.id, { code: "TEST_FAILURE", message: "boom" })).toBe(false);
  });

  it("still retries and fails running jobs normally", async () => {
    const retryRow = makeJob({ attempt: 1, maxAttempts: 3 });
    expect(
      await markJobFailedOrRetry(makeProcessingClient(retryRow), retryRow as never, {
        code: "TEST_FAILURE",
        message: "boom",
      }),
    ).toBe("RETRYING");
    expect(retryRow.state).toBe(ProcessingJobState.RETRYING);

    const failRow = makeJob({ attempt: 3, maxAttempts: 3 });
    expect(
      await markJobFailedOrRetry(makeProcessingClient(failRow), failRow as never, {
        code: "TEST_FAILURE",
        message: "boom",
      }),
    ).toBe("FAILED");
    expect(failRow.state).toBe(ProcessingJobState.FAILED);
  });

  it("export job transitions are guarded the same way", async () => {
    const recovered = makeJob({ state: ProcessingJobState.RETRYING });
    expect(await markExportJobSucceeded(makeExportClient(recovered), recovered.id, "file-1")).toBe(false);
    expect(recovered.state).toBe(ProcessingJobState.RETRYING);

    const running = makeJob();
    expect(await markExportJobSucceeded(makeExportClient(running), running.id, "file-1")).toBe(true);
    expect(running.state).toBe(ProcessingJobState.SUCCEEDED);

    const raced = makeJob({ state: ProcessingJobState.RETRYING, attempt: 1, maxAttempts: 3 });
    expect(
      await markExportJobFailedOrRetry(makeExportClient(raced), raced as never, {
        code: "RENDER_FAILED",
        message: "boom",
      }),
    ).toBe("SKIPPED");
    expect(raced.state).toBe(ProcessingJobState.RETRYING);
  });
});

describe("withHeartbeat lost-claim handling", () => {
  it("aborts in-flight work when the heartbeat reports a lost claim", async () => {
    vi.useFakeTimers();
    try {
      let beats = 0;
      const heartbeat = async () => {
        beats += 1;
        if (beats > 1) {
          throw new HeartbeatLostError("job-1");
        }
      };
      const neverFinishes = () => new Promise<never>(() => {});

      const result = withHeartbeat(heartbeat, neverFinishes, 1000);
      const assertion = expect(result).rejects.toBeInstanceOf(HeartbeatLostError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores transient heartbeat failures and lets the work finish", async () => {
    vi.useFakeTimers();
    try {
      let beats = 0;
      const heartbeat = async () => {
        beats += 1;
        if (beats === 2) {
          throw new Error("db blip");
        }
      };
      const work = () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("done"), 2500);
        });

      const result = withHeartbeat(heartbeat, work, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      await expect(result).resolves.toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
