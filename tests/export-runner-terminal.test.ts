import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/exports/handler", () => ({ runExportJob: vi.fn() }));

vi.mock("@/lib/exports/queue", () => ({
  claimNextExportJob: vi.fn(),
  heartbeatExportJob: vi.fn(async () => ({ count: 1 })),
  markExportJobFailedOrRetry: vi.fn(async () => "FAILED"),
  markExportJobSucceeded: vi.fn(async () => true),
}));

vi.mock("@/lib/observability/operational-events", () => ({
  recordOperationalEventSafely: vi.fn(async () => {}),
}));

import { ExportFailureError } from "@/lib/exports/errors";
import { runExportJob } from "@/lib/exports/handler";
import { claimNextExportJob, markExportJobFailedOrRetry } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { runOnePendingExportJob } from "@/lib/exports/runner";

const JOB = { id: "export-1", clipId: "clip-1", workspaceId: "ws-1", filename: "a.mp4", attempt: 1, editVersion: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  (claimNextExportJob as Mock).mockResolvedValue(JOB);
  (markExportJobFailedOrRetry as Mock).mockResolvedValue("FAILED");
});

describe("runOnePendingExportJob edit-version failures", () => {
  it("marks a deterministic version failure terminal so the worker never re-renders it", async () => {
    (runExportJob as Mock).mockRejectedValue(
      new ExportFailureError("EXPORT_EDIT_VERSION_NOT_FOUND", "That saved version is gone.", {
        terminal: true,
      }),
    );

    await runOnePendingExportJob();

    expect(markExportJobFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      JOB,
      expect.objectContaining({ code: "EXPORT_EDIT_VERSION_NOT_FOUND", terminal: true }),
    );
  });

  it("records the failing version on the operational event so the cause is legible", async () => {
    (runExportJob as Mock).mockRejectedValue(
      new ExportFailureError("EXPORT_EDIT_VERSION_MISSING", "This export has no saved version.", {
        terminal: true,
      }),
    );

    await runOnePendingExportJob();

    const event = (recordOperationalEventSafely as Mock).mock.calls[0][1];
    expect(event.eventType).toBe("export_job_failed");
    expect(event.metadata).toEqual(
      expect.objectContaining({ errorCode: "EXPORT_EDIT_VERSION_MISSING", editVersion: 1 }),
    );
  });

  it("leaves an ordinary render failure retryable", async () => {
    (runExportJob as Mock).mockRejectedValue(
      new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe."),
    );
    (markExportJobFailedOrRetry as Mock).mockResolvedValue("RETRYING");

    await runOnePendingExportJob();

    expect(markExportJobFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      JOB,
      expect.objectContaining({ code: "RENDER_FAILED", terminal: false }),
    );
  });

  it("leaves an unexpected error retryable rather than assuming it is deterministic", async () => {
    (runExportJob as Mock).mockRejectedValue(new Error("connection lost"));
    (markExportJobFailedOrRetry as Mock).mockResolvedValue("RETRYING");

    await runOnePendingExportJob();

    expect(markExportJobFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      JOB,
      expect.objectContaining({ code: "RENDER_FAILED", terminal: false }),
    );
  });
});
