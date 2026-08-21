import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    generatedClip: { findUnique: vi.fn() },
    clipEdit: { findFirst: vi.fn() },
    exportJob: { findUnique: vi.fn() },
    transcriptSegment: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/api/auth", () => ({
  requireApiWorkspace: vi.fn(async () => ({ workspace: { id: "ws-1" }, user: { id: "user-1" } })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkExportJobLimits: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/exports/queue", () => ({
  enqueueExportJob: vi.fn(async () => ({ id: "export-1" })),
}));

vi.mock("@/lib/observability/operational-events", () => ({
  recordOperationalEventSafely: vi.fn(async () => {}),
}));

import { buildDefaultEditorState, wordId, type EditorState } from "@/lib/editor/types";
import { CONTINUOUS_RANGE_REQUIRED } from "@/lib/exports/continuous-range";
import { enqueueExportJob } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { checkExportJobLimits } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/clips/[id]/exports/route";

const CLIP = {
  id: "clip-1",
  workspaceId: "ws-1",
  title: "The Weight of Grace",
  project: { name: "Sunday Service", series: "Grace", sourceVideoId: "video-1" },
};

const SEGMENT_ROWS = [
  {
    id: "seg-1",
    idx: 0,
    startMs: 0,
    endMs: 8000,
    words: [
      { word: "Grace", startMs: 3100, endMs: 3500, confidence: 0.9, isFiller: false, deleted: false },
      { word: "abounds", startMs: 3600, endMs: 4200, confidence: 0.9, isFiller: false, deleted: false },
      { word: "toward", startMs: 4400, endMs: 4900, confidence: 0.9, isFiller: false, deleted: false },
    ],
  },
];

function editorState(deletedWordIds: string[] = []): EditorState {
  const base = buildDefaultEditorState({
    sourceVideoId: "video-1",
    startMs: 3000,
    endMs: 7000,
  });
  return { ...base, wordEdits: { ...base.wordEdits, deletedWordIds } };
}

function request(body: unknown = { filename: "sermon.mp4" }) {
  return new Request("https://app.example/api/clips/clip-1/exports", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "clip-1" });

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.generatedClip.findUnique as Mock).mockResolvedValue(CLIP);
  (prisma.exportJob.findUnique as Mock).mockResolvedValue(null);
  (prisma.transcriptSegment.findMany as Mock).mockResolvedValue(SEGMENT_ROWS);
  (enqueueExportJob as Mock).mockResolvedValue({ id: "export-1" });
  (checkExportJobLimits as Mock).mockResolvedValue({ allowed: true });
});

describe("POST /api/clips/[id]/exports continuous-range gate", () => {
  it("refuses a clip that still cuts a word out of the middle", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      editorState: editorState([wordId("seg-1", 1)]),
    });

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(CONTINUOUS_RANGE_REQUIRED);
  });

  it("tells the user to restore the words", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      editorState: editorState([wordId("seg-1", 1)]),
    });

    const response = (await POST(request(), { params })) as Response;

    expect((await response.json()).error.message).toMatch(/Restore all deleted words/);
  });

  it("starts no render work for a refused export", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      editorState: editorState([wordId("seg-1", 1)]),
    });

    await POST(request(), { params });

    // No job row means nothing for any worker to pick up. The refusal costs one query, not a
    // queued render the user has to watch fail.
    expect(enqueueExportJob).not.toHaveBeenCalled();
  });

  it("refuses before the idempotency lookup, so re-requesting a queued cut export is refused too", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      editorState: editorState([wordId("seg-1", 1)]),
    });
    (prisma.exportJob.findUnique as Mock).mockResolvedValue({ id: "export-existing" });

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(409);
    expect(prisma.exportJob.findUnique).not.toHaveBeenCalled();
  });

  it("records the refusal as an operational event", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      editorState: editorState([wordId("seg-1", 1)]),
    });

    await POST(request(), { params });

    expect(recordOperationalEventSafely).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ eventType: "export_rejected_continuous_range" }),
    );
  });

  it("accepts a clip once the words are restored", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 4,
      editorState: editorState([]),
    });

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(200);
    expect(enqueueExportJob).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ clipId: "clip-1", editVersion: 4 }),
    );
  });

  it("accepts a cut that falls outside the clip's range", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({
      version: 3,
      // "Grace" starts at 3,100 ms and this clip starts at 5,000 ms, so the cut renders nothing.
      editorState: {
        ...editorState([wordId("seg-1", 0)]),
        source: { videoId: "video-1", startMs: 5000, endMs: 7000 },
      },
    });

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(200);
    expect(enqueueExportJob).toHaveBeenCalled();
  });

  it("accepts a clip that was never edited without reading the transcript", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue(null);

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(200);
    expect(prisma.transcriptSegment.findMany).not.toHaveBeenCalled();
  });
});
