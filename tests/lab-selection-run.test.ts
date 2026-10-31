import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgreementRanking, runLabSelection } from "@/lib/analysis/lab-selection-run";
import { SELECTION_STEPS, type ResolvedSelectionSteps, type SelectionStep } from "@/lib/analysis/selection-steps";

/**
 * The selection run with the model, the storage and the detector replaced: what each step reports
 * when it is off, when it is on, and when it fails for every clip (degraded). The steps' own
 * decisions are covered in lab-selection.test.ts and boundary-step tests; this file covers the
 * wiring the analyze job relies on.
 */

const h = vi.hoisted(() => ({
  create: vi.fn(),
  downloadToFile: vi.fn(),
  findAudioDropouts: vi.fn(),
  checkClipCamera: vi.fn(),
  events: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => h.create(...args) };
  },
}));
vi.mock("@/lib/storage", () => ({
  getStorageProvider: () => ({ downloadToFile: (...args: unknown[]) => h.downloadToFile(...args) }),
}));
vi.mock("@/lib/analysis/audio-dropout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis/audio-dropout")>()),
  findAudioDropouts: (...args: unknown[]) => h.findAudioDropouts(...args),
}));
vi.mock("@/lib/analysis/camera-check-run", () => ({
  checkClipCamera: (...args: unknown[]) => h.checkClipCamera(...args),
}));

const prisma = {
  operationalEvent: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      h.events.push(data);
      return { id: `event-${h.events.length}`, ...data };
    },
  },
} as never;

type Clip = { startMs: number; endMs: number; text: string; total: number; title: string };

const SEGMENTS = Array.from({ length: 400 }, (_, i) => ({
  idx: i,
  startMs: i * 5_000,
  endMs: i * 5_000 + 4_800,
  text: `Sentence ${i}.`,
}));

function clipAt(startS: number, total: number): Clip {
  return { startMs: startS * 1000, endMs: (startS + 55) * 1000, text: "old text", total, title: `clip at ${startS}` };
}

function stepsWith(on: SelectionStep[]): ResolvedSelectionSteps {
  const steps = {} as Record<SelectionStep, ResolvedSelectionSteps[SelectionStep]>;
  for (const step of SELECTION_STEPS) {
    steps[step] = on.includes(step) ? { on: true, reason: null } : { on: false, reason: "environment" };
  }
  return steps;
}

const ids = { prisma, workspaceId: "ws-1", projectId: "project-1", jobId: "job-1" };

beforeEach(() => {
  h.create.mockReset();
  h.downloadToFile.mockReset().mockResolvedValue(undefined);
  h.findAudioDropouts.mockReset();
  h.checkClipCamera.mockReset();
  h.events.length = 0;
});

describe("runAgreementRanking", () => {
  const ranked = [clipAt(100, 90), clipAt(300, 80), clipAt(500, 70)];

  it("returns the clips untouched and asks for nothing when the step is off", async () => {
    const scoreAgain = vi.fn();
    const result = await runAgreementRanking({ ...ids, steps: stepsWith([]), ranked, scoreAgain, usage: () => null });
    expect(result.clips).toBe(ranked);
    expect(result.degraded).toEqual([]);
    expect(scoreAgain).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("puts the moments both runs found first and records the agreement", async () => {
    const scoreAgain = vi.fn().mockResolvedValue([{ ...ranked[1] }]);
    const result = await runAgreementRanking({
      ...ids,
      steps: stepsWith(["agreementRanking"]),
      ranked,
      scoreAgain,
      usage: () => null,
    });
    expect(result.clips.map((clip) => clip.title)).toEqual(["clip at 300", "clip at 100", "clip at 500"]);
    expect(result.degraded).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ eventType: "lab_agreement_ranking", severity: "info" });
    const metadata = h.events[0].metadata as { agreed: number; error: string | null; steps: ResolvedSelectionSteps };
    expect(metadata.agreed).toBe(1);
    expect(metadata.error).toBeNull();
    expect(metadata.steps.agreementRanking).toEqual({ on: true, reason: null });
  });

  it("fails open when the second run fails, and reports the step as degraded", async () => {
    const scoreAgain = vi.fn().mockRejectedValue(new Error("second run down"));
    const result = await runAgreementRanking({
      ...ids,
      steps: stepsWith(["agreementRanking"]),
      ranked,
      scoreAgain,
      usage: () => null,
    });
    expect(result.clips).toBe(ranked);
    expect(result.degraded).toEqual([{ step: "agreementRanking", detail: "Error: second run down" }]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      eventType: "lab_agreement_ranking",
      severity: "info",
      message: "Agreement ranking: the second candidate run failed, so the first run's order stands.",
    });
    expect((h.events[0].metadata as { error: string }).error).toBe("Error: second run down");
  });
});

describe("runLabSelection", () => {
  const ranked = [clipAt(100, 90), clipAt(300, 80)];
  const base = { ...ids, segments: SEGMENTS, targetCount: 6, sourceStorageKey: "src/ws-1/video.mp4", detectorPython: "/opt/python" };

  function lastEvent() {
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ eventType: "lab_selection_steps", severity: "info" });
    return h.events[0].metadata as Record<string, unknown> & { steps: ResolvedSelectionSteps; degraded: string[] };
  }

  it("returns the clips untouched, downloads nothing and records nothing when every step is off", async () => {
    const result = await runLabSelection({ ...base, steps: stepsWith([]), ranked });
    expect(result.clips).toBe(ranked);
    expect(result.degraded).toEqual([]);
    expect(h.downloadToFile).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("keeps the dropout and camera checks off without a source file, whatever the settings say", async () => {
    const result = await runLabSelection({
      ...base,
      sourceStorageKey: null,
      steps: stepsWith(["dropoutCheck", "cameraCheck"]),
      ranked,
    });
    expect(result.clips).toBe(ranked);
    expect(h.downloadToFile).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("keeps the camera check off without the detector Python, whatever the settings say", async () => {
    const result = await runLabSelection({
      ...base,
      detectorPython: undefined,
      steps: stepsWith(["cameraCheck"]),
      ranked,
    });
    expect(result.clips).toBe(ranked);
    expect(h.checkClipCamera).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("records the resolved steps with the event when a step runs", async () => {
    h.findAudioDropouts.mockResolvedValue([]);
    const steps = stepsWith(["dropoutCheck"]);
    await runLabSelection({ ...base, steps, ranked });
    const metadata = lastEvent();
    expect(metadata.steps).toEqual(steps);
    expect(metadata.degraded).toEqual([]);
    expect(metadata).toMatchObject({ spanOn: false, boundaryOn: false, cameraOn: false, dropoutOn: true });
    expect(h.downloadToFile).toHaveBeenCalledWith("src/ws-1/video.mp4", expect.stringContaining("source-video"));
  });

  it("fails the boundary step open, clip by clip, and reports it degraded when every call failed", async () => {
    h.create.mockRejectedValue(new Error("model down"));
    const result = await runLabSelection({ ...base, steps: stepsWith(["boundaryStep"]), ranked });
    expect(result.clips.map((clip) => clip.title).sort()).toEqual(["clip at 100", "clip at 300"]);
    expect(result.degraded).toEqual([{ step: "boundaryStep", detail: "Error: model down" }]);
    const metadata = lastEvent();
    expect(metadata.degraded).toEqual(["boundaryStep"]);
    expect(metadata.boundary).toHaveLength(2);
    for (const entry of metadata.boundary as { to: unknown; error?: string }[]) {
      expect(entry.to).toBeNull();
      expect(entry.error).toBe("Error: model down");
    }
    expect(h.downloadToFile).not.toHaveBeenCalled();
  });

  it("fails the sermon span open and reports it degraded", async () => {
    h.create.mockRejectedValue(new Error("model down"));
    const result = await runLabSelection({ ...base, steps: stepsWith(["sermonSpan"]), ranked });
    expect(result.clips.map((clip) => clip.title)).toEqual(["clip at 100", "clip at 300"]);
    expect(result.degraded).toEqual([{ step: "sermonSpan", detail: "Error: model down" }]);
    expect(lastEvent().sermonSpan).toEqual({ error: "Error: model down" });
  });

  it("fails the dropout check open and reports it degraded", async () => {
    h.findAudioDropouts.mockRejectedValue(new Error("ffmpeg missing"));
    const result = await runLabSelection({ ...base, steps: stepsWith(["dropoutCheck"]), ranked });
    expect(result.clips.map((clip) => clip.title)).toEqual(["clip at 100", "clip at 300"]);
    expect(result.degraded).toEqual([{ step: "dropoutCheck", detail: "Error: ffmpeg missing" }]);
    expect(lastEvent().audioDropouts).toEqual({ error: "Error: ffmpeg missing" });
  });

  it("fails the camera check closed, and reports it degraded when it could check no clip", async () => {
    h.checkClipCamera.mockRejectedValue(new Error("detector crashed"));
    const result = await runLabSelection({ ...base, steps: stepsWith(["cameraCheck"]), ranked });
    // A clip nobody could check is not a first pick.
    expect(result.clips).toEqual([]);
    expect(result.degraded).toEqual([{ step: "cameraCheck", detail: "Error: detector crashed" }]);
    expect(h.checkClipCamera).toHaveBeenCalledTimes(2);
    expect(h.checkClipCamera.mock.calls[0][0]).toMatchObject({ python: "/opt/python", startMs: 100_000, endMs: 155_000 });
    const metadata = lastEvent();
    expect(metadata.degraded).toEqual(["cameraCheck"]);
    expect(metadata.rejected).toEqual([
      { title: "clip at 100", reason: "unchecked", at: 100 },
      { title: "clip at 300", reason: "unchecked", at: 300 },
    ]);
  });

  it("does not call a step degraded when it only failed for some clips", async () => {
    h.checkClipCamera
      .mockRejectedValueOnce(new Error("detector crashed"))
      .mockResolvedValueOnce({ result: { pass: true }, usage: { inputTokens: 0, outputTokens: 0, frames: 0, sceneFrames: 0 } });
    const result = await runLabSelection({ ...base, steps: stepsWith(["cameraCheck"]), ranked });
    expect(result.clips.map((clip) => clip.title)).toEqual(["clip at 300"]);
    expect(result.degraded).toEqual([]);
    expect(lastEvent().degraded).toEqual([]);
  });
});
