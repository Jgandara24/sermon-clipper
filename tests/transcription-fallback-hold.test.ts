import { describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
  openTranscriptionFallbackHold,
  projectsHeldForTranscriptionFallback,
  resolveTranscriptionFallbackHold,
} from "@/lib/transcription/fallback-hold";

function fakeClient() {
  return {
    editorialException: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "exc-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

// A transcript produced by the fallback provider is lower quality than the one the workspace's
// policy asked for. Clips built on it stay visible and editable, but they must not leave for an
// audience without a person looking first.
describe("openTranscriptionFallbackHold", () => {
  it("opens one editorial exception naming both providers", async () => {
    const client = fakeClient();

    await openTranscriptionFallbackHold(client as never, {
      workspaceId: "ws-1",
      projectId: "proj-1",
      jobId: "job-1",
      primaryProvider: "scribe",
      usedProvider: "whisper_cpp",
      reason: "failed",
    });

    expect(client.editorialException.create).toHaveBeenCalledTimes(1);
    const created = client.editorialException.create.mock.calls[0][0].data;
    expect(created.exceptionType).toBe(TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE);
    expect(created.workspaceId).toBe("ws-1");
    expect(created.projectId).toBe("proj-1");
    expect(created.state).toBe("OPEN");
    expect(created.metadata).toMatchObject({
      primaryProvider: "scribe",
      usedProvider: "whisper_cpp",
      reason: "failed",
    });
  });

  // Three retries of one job must not leave three identical holds for a person to close.
  it("does not open a second hold while one is already open for the project", async () => {
    const client = fakeClient();
    client.editorialException.findFirst.mockResolvedValue({ id: "exc-existing" });

    await openTranscriptionFallbackHold(client as never, {
      workspaceId: "ws-1",
      projectId: "proj-1",
      jobId: "job-2",
      primaryProvider: "scribe",
      usedProvider: "whisper_cpp",
      reason: "failed",
    });

    expect(client.editorialException.create).not.toHaveBeenCalled();
  });

  // Never carries provider error text: an editorial exception is church-visible.
  it("records provider names and reason only, never error detail", async () => {
    const client = fakeClient();

    await openTranscriptionFallbackHold(client as never, {
      workspaceId: "ws-1",
      projectId: "proj-1",
      jobId: "job-1",
      primaryProvider: "scribe",
      usedProvider: "whisper_cpp",
      reason: "unavailable",
    });

    const created = client.editorialException.create.mock.calls[0][0].data;
    expect(Object.keys(created.metadata).sort()).toEqual([
      "jobId",
      "primaryProvider",
      "reason",
      "usedProvider",
    ]);
  });
});

// A later transcription that the configured primary actually served removes the cause, and the
// clips are rebuilt from that transcript. Leaving the hold open forever would be a stuck state
// nobody could reason about later.
describe("resolveTranscriptionFallbackHold", () => {
  it("resolves an open hold when the primary provider serves the project again", async () => {
    const client = fakeClient();

    await resolveTranscriptionFallbackHold(client as never, {
      projectId: "proj-1",
      primaryProvider: "scribe",
    });

    expect(client.editorialException.updateMany).toHaveBeenCalledTimes(1);
    const call = client.editorialException.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      projectId: "proj-1",
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
    });
    expect(call.data.state).toBe("RESOLVED");
    expect(call.data.resolutionReason).toContain("scribe");
  });
});

describe("projectsHeldForTranscriptionFallback", () => {
  it("returns the set of projects with an open transcription hold", async () => {
    const client = fakeClient();
    client.editorialException.findMany.mockResolvedValue([
      { projectId: "proj-1" },
      { projectId: "proj-2" },
      { projectId: null },
    ]);

    const held = await projectsHeldForTranscriptionFallback(client as never, [
      "proj-1",
      "proj-2",
      "proj-3",
    ]);

    expect(held.has("proj-1")).toBe(true);
    expect(held.has("proj-2")).toBe(true);
    expect(held.has("proj-3")).toBe(false);
  });

  it("asks for nothing when there are no projects to check", async () => {
    const client = fakeClient();

    const held = await projectsHeldForTranscriptionFallback(client as never, []);

    expect(held.size).toBe(0);
    expect(client.editorialException.findMany).not.toHaveBeenCalled();
  });
});
