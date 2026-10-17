import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { generatedClip: { findUnique: vi.fn() }, clipEdit: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/api/auth", () => ({ requireApiPlatformOperator: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkExportJobLimits: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/exports/continuous-range", () => ({
  clipRendersContinuousRange: vi.fn(async () => true), CONTINUOUS_RANGE_REQUIRED: "CONTINUOUS_RANGE_REQUIRED",
  CONTINUOUS_RANGE_MESSAGE: "Continuous range required.",
}));
vi.mock("@/lib/review/final-render-eligibility", () => ({
  assessFinalRender: vi.fn(async () => ({ allowed: true })), FINAL_RENDER_REFUSED: "FINAL_RENDER_REFUSED",
}));
vi.mock("@/lib/observability/operational-events", () => ({ recordOperationalEventSafely: vi.fn(async () => {}) }));
vi.mock("@/lib/exports/full-source-fallback", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/exports/full-source-fallback")>()),
  enqueueFullSourceFallbackExport: vi.fn(),
}));

import { requireApiPlatformOperator } from "@/lib/api/auth";
import { enqueueFullSourceFallbackExport, FullSourceFallbackError } from "@/lib/exports/full-source-fallback";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/operator/clips/[id]/full-source-export/route";

const params = Promise.resolve({ id: "clip-1" });
const request = (body: unknown) => new Request("https://app.example/api/operator/clips/clip-1/full-source-export",
  { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiPlatformOperator as Mock).mockResolvedValue({ user: { id: "operator-1" } });
  (prisma.generatedClip.findUnique as Mock).mockResolvedValue({ id: "clip-1", workspaceId: "ws-1", title: "Grace",
    project: { name: "Sunday", series: null, sourceVideoId: "source-1" } });
  (prisma.clipEdit.findFirst as Mock).mockResolvedValue({ version: 3, editorState: {} });
  (enqueueFullSourceFallbackExport as Mock).mockResolvedValue({ created: true, job: { id: "export-1" },
    fallback: { id: "fallback-1" }, exception: { id: "exception-1" } });
});

describe("POST /api/operator/clips/[id]/full-source-export", () => {
  it("refuses callers without platform operator authority", async () => {
    (requireApiPlatformOperator as Mock).mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect(((await POST(request({ reason: "No range" }), { params })) as Response).status).toBe(403);
    expect(enqueueFullSourceFallbackExport).not.toHaveBeenCalled();
  });

  it("requires an explicit reason", async () => {
    for (const body of [{}, { reason: "  " }, { reason: "x".repeat(501) }, { reason: "ok", extra: true }]) {
      expect(((await POST(request(body), { params })) as Response).status).toBe(400);
    }
    expect(enqueueFullSourceFallbackExport).not.toHaveBeenCalled();
  });

  it("records the operator, workspace, and pinned edit version and reports the exception", async () => {
    const response = (await POST(request({ reason: "  No reviewed range covers this clip. " }), { params })) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { exportJobId: "export-1", fullSourceFallbackId: "fallback-1",
      editorialExceptionId: "exception-1" } });
    expect(enqueueFullSourceFallbackExport).toHaveBeenCalledWith(prisma, expect.objectContaining({ workspaceId: "ws-1",
      clipId: "clip-1", requestedByUserId: "operator-1", editVersion: 3, reason: "No reviewed range covers this clip." }));
    expect(recordOperationalEventSafely).toHaveBeenCalledWith(prisma, expect.objectContaining({
      eventType: "export_full_source_fallback_requested", exportJobId: "export-1" }));
  });

  it("does not record a second request event for a reused fallback", async () => {
    (enqueueFullSourceFallbackExport as Mock).mockResolvedValue({ created: false, job: { id: "export-1" },
      fallback: { id: "fallback-1" }, exception: { id: "exception-1" } });
    expect(((await POST(request({ reason: "Retry" }), { params })) as Response).status).toBe(200);
    expect(recordOperationalEventSafely).not.toHaveBeenCalled();
  });

  it.each(["FULL_SOURCE_FALLBACK_DISABLED", "FULL_SOURCE_FALLBACK_RANGE_AVAILABLE", "FULL_SOURCE_FALLBACK_ORIGINAL_UNAVAILABLE"])(
    "returns a conflict for %s", async code => {
      (enqueueFullSourceFallbackExport as Mock).mockRejectedValue(new FullSourceFallbackError(code));
      const response = (await POST(request({ reason: "No range" }), { params })) as Response;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
    });
});
