import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    generatedClip: { findUnique: vi.fn() },
    clipEdit: { findFirst: vi.fn() },
    exportJob: { findUnique: vi.fn() },
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

import { parseExportIdempotencyKeyVersion } from "@/lib/exports/edit-version";
import { enqueueExportJob } from "@/lib/exports/queue";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/clips/[id]/exports/route";

const CLIP = {
  id: "clip-1",
  workspaceId: "ws-1",
  title: "The Weight of Grace",
  project: { name: "Sunday Service", series: "Grace" },
};

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
  (enqueueExportJob as Mock).mockResolvedValue({ id: "export-1" });
});

describe("POST /api/clips/[id]/exports edit-version pinning", () => {
  it("passes the selected edit version to the queue", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 4 });

    const response = (await POST(request(), { params })) as Response;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { exportJobId: "export-1" } });
    expect(enqueueExportJob).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ clipId: "clip-1", workspaceId: "ws-1", editVersion: 4 }),
    );
  });

  it("selects version 0 for a clip that has never been edited", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue(null);

    await POST(request(), { params });

    expect((enqueueExportJob as Mock).mock.calls[0][1].editVersion).toBe(0);
  });

  it("looks the existing job up under a key carrying the same version it enqueues", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 6 });

    await POST(request(), { params });

    const lookupKey = (prisma.exportJob.findUnique as Mock).mock.calls[0][0].where.idempotencyKey;
    expect(parseExportIdempotencyKeyVersion(lookupKey)).toBe(6);
    expect((enqueueExportJob as Mock).mock.calls[0][1].editVersion).toBe(6);
  });

  it("returns the existing job without enqueuing a second render", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 2 });
    (prisma.exportJob.findUnique as Mock).mockResolvedValue({ id: "export-existing" });

    const response = (await POST(request(), { params })) as Response;

    expect(await response.json()).toEqual({ data: { exportJobId: "export-existing" } });
    expect(enqueueExportJob).not.toHaveBeenCalled();
  });

  it("selects the newest saved version, since that is what the user is looking at", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 9 });

    await POST(request(), { params });

    expect((prisma.clipEdit.findFirst as Mock).mock.calls[0][0]).toEqual({
      where: { clipId: "clip-1" },
      orderBy: { version: "desc" },
    });
    expect((enqueueExportJob as Mock).mock.calls[0][1].editVersion).toBe(9);
  });
});
