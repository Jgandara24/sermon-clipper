import { describe, expect, it, vi } from "vitest";
import { applyLabSelectionSteps, orderByAgreement } from "@/lib/analysis/lab-selection";
import { MAX_CANDIDATE_MS } from "@/lib/jobs/handlers/analyze";

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

describe("clip length", () => {
  it("never builds a candidate window of 60 seconds or more (Jake, 2026-10-18)", () => {
    expect(MAX_CANDIDATE_MS).toBeLessThan(60_000);
  });
});

describe("applyLabSelectionSteps", () => {
  it("returns the clips untouched when both lab steps are off", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 80)];
    const result = await applyLabSelectionSteps(kept, {
      segments: SEGMENTS,
      targetCount: 6,
      boundary: null,
      cameraCheck: null,
    });
    expect(result.clips).toBe(kept);
  });

  it("moves each top clip to the chosen sentences and rewrites its text", async () => {
    const kept = [clipAt(100, 90)];
    const boundary = vi.fn().mockResolvedValue({ startMs: 95_000, endMs: 160_000 - 200 });
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips[0]).toMatchObject({ startMs: 95_000, endMs: 159_800, title: "clip at 100" });
    expect(result.clips[0].text).toBe(SEGMENTS.slice(19, 32).map((s) => s.text).join(" "));
  });

  it("keeps a clip's original range when the boundary step has no valid answer", async () => {
    const kept = [clipAt(100, 90)];
    const boundary = vi.fn().mockResolvedValue(null);
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips[0]).toMatchObject({ startMs: 100_000, endMs: 155_000 });
  });

  it("moves a clip with no valid boundary answer behind every clip the step fixed (lab sermon 3 clip 5)", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 85), clipAt(500, 80)];
    const boundary = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 100_000 ? null : { startMs: clip.startMs, endMs: clip.endMs - 10_000 }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 300", "clip at 500", "clip at 100"]);
    expect(result.clips[2]).toMatchObject({ startMs: 100_000, endMs: 155_000 });
  });

  it("puts deep reserves the step never saw ahead of clips it could not fix", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 85), clipAt(500, 80)];
    const boundary = vi.fn().mockImplementation(async (clip: Clip) => (clip.startMs === 100_000 ? null : { startMs: clip.startMs, endMs: clip.endMs }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null, boundaryTopN: 2 });
    expect(boundary).toHaveBeenCalledTimes(2);
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 300", "clip at 500", "clip at 100"]);
  });

  it("drops the lower-scored clip when two clips now overlap heavily", async () => {
    const kept = [clipAt(100, 90), clipAt(140, 80)];
    const boundary = vi.fn().mockResolvedValue({ startMs: 100_000, endMs: 170_000 });
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100"]);
  });

  it("drops a clip that shares more than half of a shorter clip, even inside a much longer one (lab sermon 4c)", async () => {
    // Gate run, 2026-10-20: 4c clip 6 became 85 seconds and held all 29.6 seconds of clip 5; their
    // intersection over union was 0.35, so both stayed. Jake failed both 4c clips that overlapped.
    const kept = [clipAt(100, 90), clipAt(300, 80)];
    const boundary = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 100_000 ? { startMs: 100_000, endMs: 185_000 } : { startMs: 130_000, endMs: 160_000 }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100"]);
  });

  it("keeps two clips that share less than half of the shorter one", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 80)];
    const boundary = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 100_000 ? { startMs: 100_000, endMs: 140_000 } : { startMs: 130_000, endMs: 170_000 }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100", "clip at 300"]);
  });

  it("rejects clips that fail the camera check and lets the next clip move up, in rank order", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 85), clipAt(500, 80), clipAt(700, 75), clipAt(900, 70)];
    const cameraCheck = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 300_000 ? { pass: false, reason: "slide", at: 310 } : { pass: true }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 3, boundary: null, cameraCheck });

    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100", "clip at 500", "clip at 700", "clip at 900"]);
    expect(result.rejected).toEqual([{ title: "clip at 300", reason: "slide", at: 310 }]);
    // Stops checking once the target count has passed; the last reserve is left unchecked.
    expect(cameraCheck).toHaveBeenCalledTimes(4);
  });
});

// Fix Q. Lab sermon 4f clip 2 (2026-10-21) played 3.5 seconds of the livestream's lost sound. Jake:
// "we can't allows that to be posted."
describe("applyLabSelectionSteps rejects a clip with an audio dropout (fix Q)", () => {
  const dropout = { startMs: 310_000, endMs: 313_500 };

  it("rejects it before the camera check and lets the next clip move up", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 85), clipAt(500, 80), clipAt(700, 75)];
    const cameraCheck = vi.fn().mockResolvedValue({ pass: true });
    const result = await applyLabSelectionSteps(kept, {
      segments: SEGMENTS, targetCount: 3, boundary: null, cameraCheck, audioDropouts: [dropout],
    });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100", "clip at 500", "clip at 700"]);
    expect(result.rejected).toEqual([{ title: "clip at 300", reason: "audio dropout", at: 310 }]);
    expect(cameraCheck.mock.calls.map(([clip]) => clip.title)).toEqual(["clip at 100", "clip at 500", "clip at 700"]);
  });

  it("checks the range the boundary step chose, and the reserves too, with no camera check", async () => {
    // The boundary step moves clip at 250 onto the dropout; the reserve at 305 holds it as well.
    const kept = [clipAt(100, 90), clipAt(250, 85), clipAt(305, 60)];
    const boundary = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 250_000 ? { startMs: 270_000, endMs: 320_000 } : { startMs: clip.startMs, endMs: clip.endMs }));
    const result = await applyLabSelectionSteps(kept, {
      segments: SEGMENTS, targetCount: 6, boundary, boundaryTopN: 2, cameraCheck: null, audioDropouts: [dropout],
    });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100"]);
    expect(result.rejected.map((r) => r.title)).toEqual(["clip at 250", "clip at 305"]);
  });

  it("keeps every clip when the service has no dropout", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 85)];
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary: null, cameraCheck: null, audioDropouts: [] });
    expect(result.clips).toBe(kept);
    expect(result.rejected).toEqual([]);
  });
});

// Fix J. Lab sermon 4b clip 6 (2026-10-19) came from the welcome before a baptism, 20 minutes
// before the sermon began; Jake failed it on test 2. Only the sermon may become a clip.
describe("applyLabSelectionSteps keeps only the sermon (fix J)", () => {
  const sermon = { startMs: 250_000, endMs: 1_000_000 };

  it("drops clips outside the sermon before the boundary step sees them", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 80), clipAt(1200, 70)];
    const boundary = vi.fn().mockImplementation(async (clip: Clip) => ({ startMs: clip.startMs, endMs: clip.endMs }));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null, sermonSpan: sermon });
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary.mock.calls[0][0]).toMatchObject({ title: "clip at 300" });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 300"]);
    expect(result.outsideSermon).toBe(2);
  });

  it("drops a clip that still crosses the edge of the sermon after the boundary step", async () => {
    // Both raw windows are mostly inside. The step fixes one inside the sermon and cannot fix the other.
    const kept = [clipAt(240, 90), clipAt(960, 80)];
    const boundary = vi
      .fn()
      .mockImplementation(async (clip: Clip) => (clip.startMs === 240_000 ? { startMs: 250_000, endMs: 290_000 } : null));
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null, sermonSpan: sermon });
    expect(result.clips.map((c) => [c.title, c.startMs, c.endMs])).toEqual([["clip at 240", 250_000, 290_000]]);
    expect(result.outsideSermon).toBe(1);
  });

  it("filters before the camera check, so a non-sermon clip is never a first pick", async () => {
    const kept = [clipAt(100, 90), clipAt(300, 80)];
    const cameraCheck = vi.fn().mockResolvedValue({ pass: true });
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 1, boundary: null, cameraCheck, sermonSpan: sermon });
    expect(cameraCheck).toHaveBeenCalledTimes(1);
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 300"]);
  });

  it("keeps every clip when no span was found", async () => {
    const kept = [clipAt(100, 90), clipAt(1200, 70)];
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary: null, cameraCheck: null, sermonSpan: null });
    expect(result.clips).toBe(kept);
    expect(result.outsideSermon).toBe(0);
  });
});

describe("orderByAgreement puts the moments a second candidate run also found first (agreement ranking, 2026-10-29)", () => {
  it("keeps score order inside each group and reports the agreed clips", () => {
    const ranked = [clipAt(100, 90), clipAt(300, 85), clipAt(500, 80), clipAt(700, 75)];
    // The second run found the 300 clip ten seconds later and the 700 clip exactly.
    const second = [{ startMs: 310_000, endMs: 365_000 }, { startMs: 700_000, endMs: 755_000 }];
    const { clips, agreed } = orderByAgreement(ranked, second);
    expect(clips.map((clip) => clip.title)).toEqual(["clip at 300", "clip at 700", "clip at 100", "clip at 500"]);
    expect(agreed).toEqual([ranked[1], ranked[3]]);
  });

  it("counts a moment as the same only when the clips share more than half of the longer one", () => {
    const ranked = [clipAt(100, 90), clipAt(300, 85)];
    // 28 of 55 seconds in common: the same moment. 27 of 55: not.
    expect(orderByAgreement(ranked, [{ startMs: 327_000, endMs: 382_000 }]).agreed).toEqual([ranked[1]]);
    expect(orderByAgreement(ranked, [{ startMs: 328_000, endMs: 383_000 }]).agreed).toEqual([]);
    // A 20-second window inside the 55-second clip is not the same moment (lab 4l clip 3).
    expect(orderByAgreement(ranked, [{ startMs: 310_000, endMs: 330_000 }]).agreed).toEqual([]);
  });

  it("leaves the order alone when the second run found none of the moments", () => {
    const ranked = [clipAt(100, 90), clipAt(300, 85)];
    const { clips, agreed } = orderByAgreement(ranked, [{ startMs: 900_000, endMs: 955_000 }]);
    expect(clips).toEqual(ranked);
    expect(agreed).toEqual([]);
  });
});
