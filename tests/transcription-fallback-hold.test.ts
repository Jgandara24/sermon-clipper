import { describe, expect, it, vi } from "vitest";
import {
  ScribeTranscriptionProvider,
  WhisperCppTranscriptionProvider,
} from "@/lib/transcription";
import {
  TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
  openTranscriptionFallbackHold,
  projectsHeldForTranscriptionFallback,
  settleTranscriptionFallbackHold,
  transcriptProviderNameFor,
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

describe("settleTranscriptionFallbackHold", () => {
  const hold = { id: "exc-1", createdAt: new Date("2026-08-19T10:00:00Z") };

  function client(options: {
    hold?: { id: string; createdAt: Date } | null;
    edits?: number;
    approvals?: number;
    exports?: number;
  }) {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      tx: {
        editorialException: {
          findFirst: vi.fn().mockResolvedValue(options.hold === undefined ? hold : options.hold),
          update: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
            updates.push(args);
            return {};
          }),
        },
        // Edits are fetched, not counted: the machine's own initial document has to be told
        // apart from a person's by what the document says, and a JSON filter for "not that" is a
        // NOT over a comparison that is NULL for every row without the key.
        clipEdit: {
          findMany: vi
            .fn()
            .mockResolvedValue(
              Array.from({ length: options.edits ?? 0 }, () => ({ editorState: {} })),
            ),
        },
        clipApproval: { count: vi.fn().mockResolvedValue(options.approvals ?? 0) },
        exportJob: { count: vi.fn().mockResolvedValue(options.exports ?? 0) },
      },
    };
  }

  it("does nothing when the project carries no open hold", async () => {
    const { tx, updates } = client({ hold: null });

    const outcome = await settleTranscriptionFallbackHold(tx as never, {
      projectId: "proj-1",
      transcriptProvider: "elevenlabs_scribe_v2",
      primaryProvider: "scribe",
    });

    expect(outcome).toEqual({ settled: "no_hold" });
    expect(updates).toHaveLength(0);
  });

  // Condition 1: the rebuild must be from the primary. A whisper.cpp or SRT-override transcript
  // is not the primary re-serving, so the cause of the hold has not gone away.
  it("keeps the hold open when the transcript did not come from the primary", async () => {
    for (const provider of ["whisper_cpp", "srt_upload"]) {
      const { tx, updates } = client({});

      const outcome = await settleTranscriptionFallbackHold(tx as never, {
        projectId: "proj-1",
        transcriptProvider: provider,
        primaryProvider: "scribe",
      });

      expect(outcome).toEqual({ settled: "kept_open", reason: "transcript_not_from_primary" });
      expect(updates).toHaveLength(0);
    }
  });

  // Condition 3: a person edited, approved, or exported a clip built on the fallback transcript.
  // The rebuild throws that work away, so a machine must not quietly declare it reconciled.
  it.each([
    ["edits", { edits: 1 }],
    ["approvals", { approvals: 1 }],
    ["exports", { exports: 1 }],
  ])("keeps the hold open when human %s exist from the fallback transcript", async (_label, counts) => {
    const { tx, updates } = client(counts);

    const outcome = await settleTranscriptionFallbackHold(tx as never, {
      projectId: "proj-1",
      transcriptProvider: "elevenlabs_scribe_v2",
      primaryProvider: "scribe",
    });

    expect(outcome).toEqual({
      settled: "kept_open",
      reason: "human_work_needs_reconciliation",
    });
    expect(updates).toHaveLength(1);
    const data = updates[0].data as Record<string, unknown>;
    expect(data.state).toBeUndefined();
    expect(data.metadata).toMatchObject({ manualReconciliationRequired: true });
  });

  // Only work done while the hold was open counts. Edits made before the fallback belong to an
  // earlier transcript and must not block resolution forever.
  it("counts only human work created at or after the hold opened", async () => {
    const { tx } = client({});

    await settleTranscriptionFallbackHold(tx as never, {
      projectId: "proj-1",
      transcriptProvider: "elevenlabs_scribe_v2",
      primaryProvider: "scribe",
    });

    for (const counter of [tx.clipEdit.findMany, tx.clipApproval.count, tx.exportJob.count]) {
      expect(counter).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gte: hold.createdAt } }),
        }),
      );
    }
  });

  it("resolves only when the primary served and no human work needs reconciling", async () => {
    const { tx, updates } = client({});

    const outcome = await settleTranscriptionFallbackHold(tx as never, {
      projectId: "proj-1",
      transcriptProvider: "elevenlabs_scribe_v2",
      primaryProvider: "scribe",
    });

    expect(outcome).toEqual({ settled: "resolved" });
    expect(updates).toHaveLength(1);
    const data = updates[0].data as Record<string, unknown>;
    expect(data.state).toBe("RESOLVED");
    expect(data.resolvedAt).toBeInstanceOf(Date);
    expect(String(data.resolutionReason)).toContain("scribe");
    expect(String(data.resolutionReason)).toContain("rebuilt");
  });
});

describe("transcriptProviderNameFor", () => {
  // The map exists because Transcript.provider stores the provider class's own name string. If
  // a class is renamed and this map is not, auto-resolution silently stops working.
  it("matches the name each provider class actually reports", () => {
    expect(transcriptProviderNameFor("scribe")).toBe(new ScribeTranscriptionProvider({}).name);
    expect(transcriptProviderNameFor("whisper_cpp")).toBe(
      new WhisperCppTranscriptionProvider().name,
    );
  });
});
