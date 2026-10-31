import { describe, expect, it, vi } from "vitest";

// Stop the real handler at its external boundaries. No database or provider client loads here.
vi.mock("@/lib/env", () => ({ env: { CANDIDATE_LIMIT_DEFAULT: 18, CANDIDATE_LIMIT_MAXIMUM: 18, AUTOMATIC_SCHEDULE_ARMING_ENABLED: false }, detectorPython: () => undefined }));
vi.mock("@/lib/analysis", () => ({ getAnalysisProvider: vi.fn(() => { throw new Error("Unexpected provider lookup."); }) }));
vi.mock("@/lib/analysis/routing-store", () => ({ resolveAndSnapshotProjectAnalysisRouting: vi.fn() }));
vi.mock("@/lib/cost/record", () => ({ recordProcessingCostFactSafely: vi.fn() }));
vi.mock("@/lib/observability/operational-events", () => ({ recordOperationalEvent: vi.fn(), recordOperationalEventSafely: vi.fn() }));
vi.mock("@/lib/scheduling", () => ({ clearReschedulableScheduledPosts: vi.fn(), findScheduledPostCollision: vi.fn() }));
vi.mock("@/lib/review/render-coordinator", () => ({ coordinateScheduledRenders: vi.fn(async () => ({ slotsBound: 0 })) }));
vi.mock("@/lib/schedule/posting-schedule", () => ({ allocatePostingSlots: vi.fn(() => []) }));
vi.mock("@/lib/project-service", () => ({ readProjectProcessingConfig: () => ({ timezone: "UTC", sermonsPerWeek: 1, serviceOccurrence: "PRIMARY" }) }));
vi.mock("@/lib/retention", () => ({ lockSourceVideoForRetention: vi.fn(), sourceExpiresAtForSchedule: vi.fn() }));
vi.mock("@/lib/transcription/policy", () => ({ resolveTranscriptionProviderPolicy: () => ({ primary: "scribe" }) }));

import { createAnalyzeJobHandler } from "../../src/lib/jobs/handlers/analyze";
import { POLICY } from "../../src/lib/analysis/complete-message/contract";
import { sourceRevision } from "../../src/lib/analysis/complete-message/integration";
import { prepareCompleteMessageTranscript, readCompleteMessagePolicy } from "../../src/lib/analysis/complete-message/integration";
import { buildCandidateWindows, dedupByOverlap, refineBoundaries } from "../../src/lib/analysis/chunking";
import { fakeAdapter, mockUsage } from "./fixtures";
import { makeCase } from "../p2-complete-message-stage2/fixtures";
import { sentenceNotMessage } from "../p2-complete-message/fixtures";
import type { ScoredCandidate } from "../../src/lib/analysis/types";

function setup(enabled: boolean | undefined = true) {
  const f = makeCase(sentenceNotMessage());
  const storedTranscript = {
    id: "transcript-local", updatedAt: new Date("2026-09-19T00:00:00Z"), provider: "whisper_cpp",
    fullText: f.source.segments.map((s) => s.text).join(" "),
    segments: f.source.segments.map((s, idx) => ({
      id: s.id, idx, startMs: s.startMs, endMs: s.endMs, text: s.text,
      words: s.words.map((w) => ({ word: w.text, startMs: w.startMs, endMs: w.endMs, confidence: 1, deleted: false, isFiller: false })),
    })),
  };
  const sourceInput = { durationMs: f.source.sourceDurationMs, transcriptRevision: 7, transcript: storedTranscript };
  const setting = { enabled: true as const, version: POLICY.version, evidence: {
    revision: sourceRevision(sourceInput), regions: f.source.regions, gaps: f.source.gaps,
  } };
  const processingConfig = enabled === undefined ? {} : { completeMessagePolicy: { ...setting, enabled } };
  const project = {
    id: "project-local", workspaceId: "workspace-local", sourceVideoId: "source-local", processingConfig,
    workspace: { settings: {} },
    sermonDate: null, expiresAt: null,
    sourceVideo: { id: "source-local", durationS: { toNumber: () => f.source.sourceDurationMs / 1000 }, transcriptRevision: 7, transcript: storedTranscript },
  };
  const prepared = prepareCompleteMessageTranscript(sourceInput, readCompleteMessagePolicy({ completeMessagePolicy: setting })!);
  const mock = fakeAdapter(prepared);
  const sourceSegments = storedTranscript.segments.map((s) => ({ idx: s.idx, startMs: s.startMs, endMs: s.endMs, text: s.text }));
  const legacyScores: ScoredCandidate[] = buildCandidateWindows(sourceSegments).slice(0, 2).map((c, i) => ({
    ...c, title: "Legacy title", hookText: "Legacy hook", summary: "Legacy summary", excerpt: c.text,
    total: 80 - i, subscores: { platform_fit: { score: 50, letter: "F", note: "Legacy score." } }, modelVersion: "legacy",
  }));
  mock.legacy.scoreCandidates = vi.fn(async () => structuredClone(legacyScores));
  const mutations: string[] = [];
  const write = (name: string) => vi.fn(async () => { mutations.push(name); return { count: 1 }; });
  const client = {
    project: { findUniqueOrThrow: vi.fn(async () => project), findUnique: vi.fn(async () => project), update: write("project.update") },
    clipEdit: { count: vi.fn(async () => 0), create: write("clipEdit.create") },
    clipApproval: { count: vi.fn(async () => 0) },
    exportJob: { count: vi.fn(async () => 0) },
    scheduledPost: { count: vi.fn(async () => 0) },
    clipReview: { count: vi.fn(async () => 0) },
    editorialException: {
      findFirst: vi.fn(async () => ({ id: "hold-local", createdAt: new Date("2026-09-18") })),
      update: write("hold.update"), updateMany: write("exceptions.updateMany"),
    },
    scriptureReference: { deleteMany: write("scripture.deleteMany"), createMany: write("scripture.createMany") },
    generatedClip: {
      deleteMany: write("clips.deleteMany"),
      create: vi.fn(async (_args: unknown) => { mutations.push("clip.create"); return { id: "clip-local" }; }),
    },
    clipScore: { create: write("score.create") },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback(client)),
  };
  const selection = { provider: mock.legacy, providerKind: "google" as const, selectionReason: "master_policy" as const, emergencyOverride: false };
  const selectProvider = vi.fn(async () => selection);
  const recordCostFact = vi.fn();
  const handler = createAnalyzeJobHandler({ selectProvider, resolveRouting: vi.fn(), recordCostFact });
  const run = () => handler({ prisma: client as never, job: { id: "job-local", projectId: project.id, attempt: 1 } as never });
  return { ...mock, f, project, client, mutations, run, selectProvider, recordCostFact, legacyScores, sourceSegments };
}

describe("Stage 3 handler integration with fake storage", () => {
  it.each([false, undefined])("preserves legacy output when policy enabled is %s", async (enabled) => {
    // Passing undefined through the default argument needs an explicit empty snapshot below.
    const f = setup(false);
    if (enabled === undefined) f.project.processingConfig = {};
    const result = await f.run();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.legacy.scoreCandidates).toHaveBeenCalledTimes(1);
    const expected = dedupByOverlap(f.legacyScores.map((c) => ({ ...refineBoundaries(c, f.f.source.sourceDurationMs), score: c.total })), 0.5);
    const calls = f.client.generatedClip.create.mock.calls.map(([args]) => args as { data: { startMs: number; endMs: number } });
    expect(calls.map((c) => [c.data.startMs, c.data.endMs])).toEqual(expected.map((c) => [c.startMs, c.endMs]));
    expect(result?.metadata).not.toHaveProperty("completeMessage");
    expect(f.client.editorialException.update).not.toHaveBeenCalled();
  });

  it("persists a validated 152-second range without a second padding pass", async () => {
    const f = setup();
    const result = await f.run();
    expect(f.legacy.scoreCandidates).not.toHaveBeenCalled();
    expect(f.client.generatedClip.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      startMs: f.f.range.startMs - 150, endMs: f.f.range.endMs + 150, transcriptRevision: 7,
    }) }));
    expect(result?.metadata).toHaveProperty("completeMessage.policyVersion", POLICY.version);
    expect(f.recordCostFact).toHaveBeenCalledTimes(2);
    expect(f.client.editorialException.update).not.toHaveBeenCalled();
    expect(f.client.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.client.clipReview.count).toHaveBeenCalledTimes(2);
  });

  it.each(["edits", "approvals", "exports", "reviews"])("refuses before model calls when %s exist", async (kind) => {
    const f = setup();
    if (kind === "edits") f.client.clipEdit.count.mockResolvedValueOnce(1);
    if (kind === "approvals") f.client.clipApproval.count.mockResolvedValue(1);
    if (kind === "exports") f.client.exportJob.count.mockResolvedValue(1);
    if (kind === "reviews") f.client.clipReview.count.mockResolvedValue(1);
    await expect(f.run()).rejects.toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
    expect(f.selectProvider).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });

  it("rechecks durable work under locks before replacement", async () => {
    const f = setup();
    f.client.clipApproval.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(f.run()).rejects.toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.client.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.mutations).toEqual([]);
  });

  it("refuses a changed transcript before replacement", async () => {
    const f = setup();
    f.client.project.findUnique.mockResolvedValueOnce({ ...f.project, sourceVideo: { ...f.project.sourceVideo, transcriptRevision: 8 } });
    await expect(f.run()).rejects.toMatchObject({ code: "TRANSCRIPT_CHANGED", preservesProject: true });
    expect(f.mutations).toEqual([]);
  });

  it("refuses changed policy settings under locks", async () => {
    const f = setup();
    f.client.project.findUnique.mockResolvedValueOnce({ ...f.project, processingConfig: {} });
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_POLICY_CHANGED", preservesProject: true });
    expect(f.mutations).toEqual([]);
  });

  it("allows unrelated routing snapshots without changing the complete-message policy", async () => {
    const f = setup();
    f.client.project.findUnique.mockResolvedValueOnce({ ...f.project,
      processingConfig: { ...f.project.processingConfig, analysisRouting: { model: "synthetic-model" } },
    } as never);
    await f.run();
    expect(f.client.generatedClip.create).toHaveBeenCalledTimes(1);
  });

  it("preserves the project when provider selection fails", async () => {
    const f = setup();
    f.selectProvider.mockRejectedValueOnce(new Error("Synthetic selection failure."));
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_ANALYSIS_INCOMPLETE", preservesProject: true });
    expect(f.mutations).toEqual([]);
  });

  it("refuses unsupported adapters without legacy fallback or writes", async () => {
    const f = setup();
    delete (f.legacy as { completeMessageAdapter?: unknown }).completeMessageAdapter;
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_ANALYSIS_INCOMPLETE", retryable: false, preservesProject: true });
    expect(f.mutations).toEqual([]);
    expect(f.legacy.scoreCandidates).not.toHaveBeenCalled();
  });

  it("refuses stale region evidence before model calls", async () => {
    const f = setup();
    f.project.processingConfig.completeMessagePolicy!.evidence.revision = "stale";
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_ANALYSIS_INCOMPLETE", preservesProject: true });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });

  it("keeps the existing pool when classification returns no complete messages", async () => {
    const f = setup();
    f.invoke.mockImplementation(async (call) => ({ truncated: false, usage: mockUsage(call.stage), output: {
      version: 1, requestId: "block-1", revision: JSON.parse(call.payload).request.revision, proposals: [],
    } }) as never);
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_NO_CLIPS", retryable: false, preservesProject: true });
    expect(f.client.$transaction).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });

  it("does not replace clips after a token-budget failure", async () => {
    const f = setup();
    f.adapter.measureInputTokens = () => 12_001;
    await expect(f.run()).rejects.toMatchObject({ code: "COMPLETE_MESSAGE_ANALYSIS_INCOMPLETE", preservesProject: true });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.client.$transaction).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });
});
