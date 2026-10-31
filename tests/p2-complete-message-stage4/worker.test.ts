import { Readable } from "node:stream";
import { Prisma, type PrismaClient, type ExportJob } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ createReadStream: () => Readable.from(["synthetic output bytes"]) }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/unused-synthetic-directory"), rm: vi.fn(),
  stat: vi.fn(async () => ({ size: 100 })),
}));
vi.mock("@/lib/env", () => ({ env: {}, detectorPython: () => undefined }));
vi.mock("@/lib/cost/record", () => ({ recordProcessingCostFactSafely: vi.fn() }));
vi.mock("@/lib/observability/operational-events", () => ({ recordOperationalEventSafely: vi.fn() }));
vi.mock("@/lib/export/render", () => ({ renderClipExport: vi.fn(async () => {}) }));
vi.mock("@/lib/media-artifacts/read-lease", () => ({ withMaterializedRange: vi.fn() }));
vi.mock("@/lib/exports/range-render", () => ({ renderCandidateRangeExport: vi.fn() }));
vi.mock("@/lib/media/probe", () => ({ probeVideoFile: vi.fn() }));
vi.mock("@/lib/export/font-metrics", () => ({
  createCaptionMeasurer: () => ({ measure: (text: string) => text.length * 10, spaceWidth: 10 }),
  UnbundledCaptionFaceError: class extends Error {},
}));
vi.mock("@/lib/storage", () => ({
  getStorageProvider: vi.fn(), storageProviderKind: () => "synthetic", storageTransferCostFact: () => ({}),
}));
import { getStorageProvider } from "@/lib/storage";
import { probeVideoFile } from "@/lib/media/probe";
import { renderClipExport } from "@/lib/export/render";
import { withMaterializedRange } from "@/lib/media-artifacts/read-lease";
import { renderCandidateRangeExport } from "@/lib/exports/range-render";
import { runExportJob } from "@/lib/exports/handler";
import { fixture } from "./fixtures";

function setup(enabled = true) {
  const f = fixture();
  f.source!.id = "11111111-1111-4111-8111-111111111111";
  f.state.source.videoId = f.source!.id;
  if (!enabled) f.processingConfig = { completeMessagePolicy: { enabled: false } };
  const storage = { downloadToFile: vi.fn(), uploadFile: vi.fn(), size: vi.fn(async () => 100) };
  vi.mocked(getStorageProvider).mockReturnValue(storage as never);
  vi.mocked(probeVideoFile).mockResolvedValue({ durationS: 152, fps: 30, width: 1080, height: 1920, hasAudio: true });
  const source = { id: f.source!.id, durationS: new Prisma.Decimal(f.source!.durationMs! / 1000),
    storageKey: "synthetic-source", width: 1920, height: 1080, sizeBytes: BigInt(100),
    transcript: { segments: f.segments } };
  const client = {
    sourceVideo: { findFirst: vi.fn(async () => ({ id: source.id })) },
    mediaRegion: { findMany: vi.fn(async () => []) },
    exportRangeInput: { findUnique: vi.fn(async () => null) },
    exportFullSourceFallback: { findUnique: vi.fn(async () => null) },
    generatedClip: { findUniqueOrThrow: vi.fn(async () => ({
      projectId: "synthetic-project", startMs: 0, endMs: 5000,
      project: { sourceVideo: source, processingConfig: f.processingConfig, workspace: { settings: {} } },
    })) },
    clipEdit: { findUnique: vi.fn(async () => ({ editorState: f.state })), findFirst: vi.fn() },
    exportJob: { update: vi.fn() }, exportedFile: { create: vi.fn(async () => ({ id: "synthetic-file" })) },
  };
  const run = () => runExportJob(client as unknown as PrismaClient, {
    id: "synthetic-export", clipId: "synthetic-clip", workspaceId: "22222222-2222-4222-8222-222222222222", editVersion: 4, attempt: 1,
  } as ExportJob);
  return { f, source, client, storage, run };
}

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("P4_RANGE_EXPORTS_ENABLED", "false"); });
afterEach(() => vi.unstubAllEnvs());
describe("export worker wiring with all media and file services mocked", () => {
  function pinRange() {
    const context = setup();
    const { f, client, source } = context;
    const pin = { artifactId: "range-artifact", reviewId: "range-review", sourceVideoId: source.id,
      sourceSha256: "a".repeat(64), artifactSha256: "b".repeat(64), editVersion: 4,
      startMs: BigInt(f.state.source.startMs), endMs: BigInt(f.state.source.endMs) };
    client.exportRangeInput.findUnique.mockResolvedValue(pin as never);
    return { ...context, pin };
  }

  it("renders an explicit range pin without an original key and retains output QC", async () => {
    vi.stubEnv("P4_RANGE_EXPORTS_ENABLED", "true");
    const { run, source, storage, client, pin } = pinRange();
    (source as { storageKey: string | null }).storageKey = null;
    vi.mocked(withMaterializedRange).mockImplementation(async (_p, _s, _r, work) => work({
      artifact: { byteCount: BigInt(20) }, sourceWidth: 1920, sourceHeight: 1080, path: "/synthetic-range.nut", retentionHeldByExportJobId: "synthetic-export",
      download: { transferredBytes: 20, cacheState: "miss" },
    } as never));
    await expect(run()).resolves.toBe("synthetic-file");
    expect(withMaterializedRange).toHaveBeenCalledWith(client, storage, expect.objectContaining({
      artifactId: pin.artifactId, exportJobId: "synthetic-export", sourceSha256: pin.sourceSha256,
    }), expect.any(Function));
    expect(renderCandidateRangeExport).toHaveBeenCalledWith(expect.objectContaining({
      render: expect.objectContaining({ sourceFilePath: "/synthetic-range.nut" }),
    }));
    expect(renderClipExport).not.toHaveBeenCalled();
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(client.exportJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      qcDetails: expect.objectContaining({ mediaInput: expect.objectContaining({ kind: "CANDIDATE_RANGE", artifactId: pin.artifactId }) }),
    }) }));
  });

  it("refuses disabled range exports without an original-source fallback", async () => {
    const { run, storage } = pinRange();
    await expect(run()).rejects.toMatchObject({ code: "RANGE_EXPORTS_DISABLED", terminal: true });
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(withMaterializedRange).not.toHaveBeenCalled();
  });

  it("makes failed pinned input terminal and never uploads or downloads the original", async () => {
    vi.stubEnv("P4_RANGE_EXPORTS_ENABLED", "true");
    const { run, storage } = pinRange();
    vi.mocked(withMaterializedRange).mockRejectedValue(new Error("review pin changed"));
    await expect(run()).rejects.toMatchObject({ code: "EXPORT_RANGE_INPUT_FAILED", terminal: true });
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(renderClipExport).not.toHaveBeenCalled();
  });

  it("uses the pinned long edit and records strict QC before upload", async () => {
    const { f, client, storage, run } = setup();
    expect(await run()).toBe("synthetic-file");
    expect(client.clipEdit.findUnique).toHaveBeenCalledWith({ where: { clipId_version: { clipId: "synthetic-clip", version: 4 } } });
    expect(client.clipEdit.findFirst).not.toHaveBeenCalled();
    expect(renderClipExport).toHaveBeenCalledWith(expect.objectContaining({
      range: { startMs: f.state.source.startMs, endMs: f.state.source.endMs },
    }));
    expect(client.exportJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      qcStatus: "PASSED", qcDetails: expect.objectContaining({ checks: expect.arrayContaining([
        expect.objectContaining({ name: "completeMessageTiming", passed: true }),
      ]) }),
    }) }));
    expect(client.exportJob.update.mock.invocationCallOrder[0]).toBeLessThan(storage.uploadFile.mock.invocationCallOrder[0]);
  });
  it.each([true, false])("checks a shortened output with enabled=%s", async (enabled) => {
    const { client, storage, run } = setup(enabled);
    vi.mocked(probeVideoFile).mockResolvedValue({ durationS: 145, fps: 30, width: 1080, height: 1920, hasAudio: true });
    if (enabled) {
      await expect(run()).rejects.toMatchObject({ code: "RENDER_QC_FAILED" });
      expect(storage.uploadFile).not.toHaveBeenCalled();
      expect(client.exportedFile.create).not.toHaveBeenCalled();
    } else {
      await expect(run()).resolves.toBe("synthetic-file");
      const recorded = JSON.stringify(client.exportJob.update.mock.calls);
      expect(recorded).not.toContain("completeMessageTiming");
    }
  });
  it.each(["bounds", "identity", "word", "cut"])("refuses %s before mocked media services", async (kind) => {
    const { f, source, storage, run } = setup();
    if (kind === "bounds") source.durationS = new Prisma.Decimal(1);
    if (kind === "identity") f.state.source.videoId = "other-source";
    if (kind === "word") f.segments[0].words = [];
    if (kind === "cut") f.state.wordEdits.deletedWordIds = [`${f.segments[0].id}:1`];
    await expect(run()).rejects.toHaveProperty("terminal", true);
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(renderClipExport).not.toHaveBeenCalled();
    expect(probeVideoFile).not.toHaveBeenCalled();
  });
});
