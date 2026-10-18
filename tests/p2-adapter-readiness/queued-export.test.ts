import { Readable } from "node:stream";
import { Prisma, type PrismaClient, type ExportJob } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ createReadStream: () => Readable.from(["synthetic output bytes"]) }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/unused-synthetic-directory"), rm: vi.fn(),
  stat: vi.fn(async () => ({ size: 100 })),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/cost/record", () => ({ recordProcessingCostFactSafely: vi.fn() }));
vi.mock("@/lib/observability/operational-events", () => ({ recordOperationalEventSafely: vi.fn() }));
vi.mock("@/lib/export/render", () => ({ renderClipExport: vi.fn(async () => {}) }));
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
import { runExportJob } from "@/lib/exports/handler";
import { fixture } from "../p2-complete-message-stage4/fixtures";

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
      project: { sourceVideo: source, processingConfig: f.processingConfig },
    })) },
    clipEdit: { findUnique: vi.fn(async () => ({ editorState: f.state })), findFirst: vi.fn() },
    exportJob: { update: vi.fn() }, exportedFile: { create: vi.fn(async () => ({ id: "synthetic-file" })) },
  };
  const job = {
    id: "synthetic-export", clipId: "synthetic-clip", workspaceId: "22222222-2222-4222-8222-222222222222", editVersion: 4, attempt: 1,
  } as ExportJob;
  const run = () => runExportJob(client as unknown as PrismaClient, job);
  return { f, source, client, storage, run, job };
}

beforeEach(() => vi.resetAllMocks());
describe("policy changes after a synthetic export job is queued", () => {
  it.each([
    [true, true, false], [true, false, true], [false, true, false], [false, false, true],
  ])("queued=%s, execution=%s, shortened output passes=%s", async (queued, execution, passes) => {
    const { f, job, client, storage, run } = setup(queued);
    const queuedJob = structuredClone(job), savedEdit = structuredClone(f.state);
    const enabledConfig = fixture().processingConfig;
    f.processingConfig = execution ? enabledConfig : { completeMessagePolicy: { enabled: false } };
    vi.mocked(probeVideoFile).mockResolvedValue({ durationS: 145, fps: 30, width: 1080, height: 1920, hasAudio: true });
    if (passes) await expect(run()).resolves.toBe("synthetic-file");
    else await expect(run()).rejects.toMatchObject({ code: "RENDER_QC_FAILED" });
    expect(client.clipEdit.findUnique).toHaveBeenCalledWith({ where: {
      clipId_version: { clipId: job.clipId, version: 4 },
    } });
    expect(client.clipEdit.findFirst).not.toHaveBeenCalled();
    expect(client.exportedFile.create).toHaveBeenCalledTimes(passes ? 1 : 0);
    expect(storage.uploadFile).toHaveBeenCalledTimes(passes ? 1 : 0);
    expect(JSON.stringify(client.exportJob.update.mock.calls).includes("completeMessageTiming")).toBe(execution);
    expect(f.state).toEqual(savedEdit);
    expect(job).toEqual(queuedJob);
  });

  it("uses legacy checks when a queued enabled policy is removed", async () => {
    const { f, run, client } = setup(true);
    f.processingConfig = {};
    vi.mocked(probeVideoFile).mockResolvedValue({ durationS: 145, fps: 30, width: 1080, height: 1920, hasAudio: true });
    await expect(run()).resolves.toBe("synthetic-file");
    expect(JSON.stringify(client.exportJob.update.mock.calls)).not.toContain("completeMessageTiming");
  });

  it("refuses malformed policy before any mocked media operation", async () => {
    const { f, storage, run } = setup(false);
    f.processingConfig = { completeMessagePolicy: { enabled: true } };
    await expect(run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_TIMING_INVALID", terminal: true });
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(renderClipExport).not.toHaveBeenCalled();
    expect(probeVideoFile).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps the loaded plan when policy changes during mocked download; enabled=%s", async (enabled) => {
    const { f, storage, run } = setup(enabled);
    storage.downloadToFile.mockImplementation(async () => {
      f.processingConfig = enabled ? { completeMessagePolicy: { enabled: false } } : fixture().processingConfig;
    });
    vi.mocked(probeVideoFile).mockResolvedValue({ durationS: 145, fps: 30, width: 1080, height: 1920, hasAudio: true });
    if (enabled) await expect(run()).rejects.toMatchObject({ code: "RENDER_QC_FAILED" });
    else await expect(run()).resolves.toBe("synthetic-file");
  });

  it("keeps the continuous-range gate after policy shutdown", async () => {
    const { f, storage, run } = setup(true);
    f.processingConfig = { completeMessagePolicy: { enabled: false } };
    f.state.wordEdits.deletedWordIds = [`${f.segments[0].id}:1`];
    const saved = structuredClone(f.state);
    await expect(run()).rejects.toMatchObject({ code: "CONTINUOUS_RANGE_REQUIRED", terminal: true });
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(f.state).toEqual(saved);
  });

  it("does not substitute a newer edit when the pinned edit is missing", async () => {
    const { f, client, storage, run } = setup(true);
    f.processingConfig = { completeMessagePolicy: { enabled: false } };
    client.clipEdit.findUnique.mockResolvedValueOnce(null as never);
    await expect(run()).rejects.toMatchObject({ code: "EXPORT_EDIT_VERSION_NOT_FOUND", terminal: true });
    expect(client.clipEdit.findFirst).not.toHaveBeenCalled();
    expect(storage.downloadToFile).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves checksum identity with enabled=%s", async (enabled) => {
    const { client, run } = setup(enabled);
    await expect(run()).resolves.toBe("synthetic-file");
    const qc = vi.mocked(client.exportJob.update).mock.calls[0] as unknown as [{ data: { qcChecksum: string } }];
    const file = vi.mocked(client.exportedFile.create).mock.calls[0] as unknown as [{ data: { checksum: string } }];
    expect(qc[0].data.qcChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(file[0].data.checksum).toBe(qc[0].data.qcChecksum);
  });
});
