import { describe, expect, it, vi } from "vitest";
import { applyLabSelectionSteps } from "@/lib/analysis/lab-selection";

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

  it("drops the lower-scored clip when two clips now overlap heavily", async () => {
    const kept = [clipAt(100, 90), clipAt(140, 80)];
    const boundary = vi.fn().mockResolvedValue({ startMs: 100_000, endMs: 170_000 });
    const result = await applyLabSelectionSteps(kept, { segments: SEGMENTS, targetCount: 6, boundary, cameraCheck: null });
    expect(result.clips.map((c) => c.title)).toEqual(["clip at 100"]);
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
