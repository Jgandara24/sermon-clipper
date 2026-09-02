import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
import { checkExportJobLimits } from "@/lib/rate-limit";
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
  (checkExportJobLimits as Mock).mockResolvedValue({ allowed: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The idempotency key the route looked the existing job up under. */
function lookupKey(): string {
  return (prisma.exportJob.findUnique as Mock).mock.calls[0][0].where.idempotencyKey;
}

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

describe("POST /api/clips/[id]/exports identity is clip and version, not filename (P1.2)", () => {
  it("looks the same job up the next day, when the default filename's date has changed", async () => {
    // The UI posts no filename, so the server builds the default from today's date. Before P1.2
    // that date sat inside the identity, so the same clip and the same saved edit silently
    // became a second render at midnight.
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59));
    await POST(request({}), { params });
    const dayOne = lookupKey();

    vi.clearAllMocks();
    (prisma.generatedClip.findUnique as Mock).mockResolvedValue(CLIP);
    (prisma.exportJob.findUnique as Mock).mockResolvedValue(null);
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (checkExportJobLimits as Mock).mockResolvedValue({ allowed: true });
    (enqueueExportJob as Mock).mockResolvedValue({ id: "export-1" });

    vi.setSystemTime(new Date(2026, 8, 3, 0, 1));
    await POST(request({}), { params });
    const dayTwo = lookupKey();

    expect(dayOne).toBe(dayTwo);
    expect(dayOne).toBe("export:clip-1:v3");
  });

  it("looks the same job up when the caller renames the file", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });

    await POST(request({ filename: "one-name.mp4" }), { params });
    const first = lookupKey();

    vi.clearAllMocks();
    (prisma.generatedClip.findUnique as Mock).mockResolvedValue(CLIP);
    (prisma.exportJob.findUnique as Mock).mockResolvedValue(null);
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (checkExportJobLimits as Mock).mockResolvedValue({ allowed: true });
    (enqueueExportJob as Mock).mockResolvedValue({ id: "export-1" });

    await POST(request({ filename: "another-name.mp4" }), { params });

    expect(lookupKey()).toBe(first);
  });

  it("returns the existing job for a renamed re-request instead of rendering again", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (prisma.exportJob.findUnique as Mock).mockResolvedValue({ id: "export-existing" });

    const response = (await POST(request({ filename: "renamed.mp4" }), { params })) as Response;

    expect(await response.json()).toEqual({ data: { exportJobId: "export-existing" } });
    expect(enqueueExportJob).not.toHaveBeenCalled();
  });

  it("still gives a newer saved version its own identity", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    await POST(request({}), { params });
    const older = lookupKey();

    vi.clearAllMocks();
    (prisma.generatedClip.findUnique as Mock).mockResolvedValue(CLIP);
    (prisma.exportJob.findUnique as Mock).mockResolvedValue(null);
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 4 });
    (checkExportJobLimits as Mock).mockResolvedValue({ allowed: true });
    (enqueueExportJob as Mock).mockResolvedValue({ id: "export-1" });

    await POST(request({}), { params });

    expect(lookupKey()).not.toBe(older);
    expect(parseExportIdempotencyKeyVersion(lookupKey())).toBe(4);
  });

  it("still passes the filename through to the queue as metadata", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });

    await POST(request({ filename: "chosen-name.mp4" }), { params });

    expect((enqueueExportJob as Mock).mock.calls[0][1].filename).toBe("chosen-name.mp4");
  });

  it("answers an idempotent re-request without spending a rate-limit check", async () => {
    // Deliberately preserved ordering: the idempotency lookup runs before checkExportJobLimits,
    // so a re-request that creates no new render is not charged against the workspace's caps.
    // With the filename out of the key this no longer opens the rename loophole it used to.
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (prisma.exportJob.findUnique as Mock).mockResolvedValue({ id: "export-existing" });

    await POST(request({}), { params });

    expect(checkExportJobLimits).not.toHaveBeenCalled();
  });

  it("charges a genuinely new export against the rate limit", async () => {
    (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3 });
    (prisma.exportJob.findUnique as Mock).mockResolvedValue(null);

    await POST(request({}), { params });

    expect(checkExportJobLimits).toHaveBeenCalledTimes(1);
  });
});
