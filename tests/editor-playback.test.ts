import { describe, expect, it } from "vitest";
import {
  clampToClip,
  msToTimecode,
  playbackActionForTime,
  positionFromPointer,
  seekByMs,
  SKIP_STEP_MS,
} from "@/lib/editor/playback";

const CLIP = { startMs: 10_000, endMs: 24_000 };

describe("clampToClip", () => {
  it("keeps a position inside the clip", () => {
    expect(clampToClip(15_000, CLIP.startMs, CLIP.endMs)).toBe(15_000);
  });

  it("pins a position before the clip to its start", () => {
    expect(clampToClip(0, CLIP.startMs, CLIP.endMs)).toBe(10_000);
  });

  it("pins a position past the clip to its end", () => {
    expect(clampToClip(999_000, CLIP.startMs, CLIP.endMs)).toBe(24_000);
  });

  it("normalises an inverted range instead of trusting the order it was given", () => {
    // Whichever way round the bounds arrive, the result lands inside the real interval.
    expect(clampToClip(5_000, 24_000, 10_000)).toBe(10_000);
    expect(clampToClip(30_000, 24_000, 10_000)).toBe(24_000);
    expect(clampToClip(15_000, 24_000, 10_000)).toBe(15_000);
  });

  it("falls back to the clip start for a position that is not a number", () => {
    expect(clampToClip(Number.NaN, CLIP.startMs, CLIP.endMs)).toBe(10_000);
  });
});

describe("skipping by three seconds", () => {
  it("steps three seconds", () => {
    expect(SKIP_STEP_MS).toBe(3_000);
  });

  it("goes forward", () => {
    expect(seekByMs(15_000, SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(18_000);
  });

  it("goes back", () => {
    expect(seekByMs(15_000, -SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(12_000);
  });

  it("stops at the clip end rather than running into the rest of the sermon", () => {
    expect(seekByMs(23_000, SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(24_000);
  });

  it("stops at the clip start rather than running into what came before", () => {
    expect(seekByMs(11_000, -SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(10_000);
  });

  it("is a no-op once already pinned to a bound", () => {
    expect(seekByMs(CLIP.endMs, SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(CLIP.endMs);
    expect(seekByMs(CLIP.startMs, -SKIP_STEP_MS, CLIP.startMs, CLIP.endMs)).toBe(CLIP.startMs);
  });
});

describe("playbackActionForTime", () => {
  const base = { startMs: CLIP.startMs, endMs: CLIP.endMs, deletedRanges: [] };

  it("keeps playing inside the clip", () => {
    expect(playbackActionForTime({ ...base, ms: 15_000 })).toEqual({ kind: "play", atMs: 15_000 });
  });

  /** The defect this slice fixes: reaching the end used to jump back to the start and keep going. */
  it("stops at the clip end instead of looping", () => {
    expect(playbackActionForTime({ ...base, ms: 24_000 })).toEqual({ kind: "stop", atMs: 24_000 });
    expect(playbackActionForTime({ ...base, ms: 24_500 })).toEqual({ kind: "stop", atMs: 24_000 });
  });

  it("reports the clip end exactly, not the overshoot the video element reported", () => {
    const action = playbackActionForTime({ ...base, ms: 25_900 });
    expect(action).toEqual({ kind: "stop", atMs: 24_000 });
  });

  it("skips over a deleted word", () => {
    const deletedRanges = [{ startMs: 16_000, endMs: 16_800 }];
    expect(playbackActionForTime({ ...base, deletedRanges, ms: 16_200 })).toEqual({
      kind: "skip",
      toMs: 16_800,
    });
  });

  it("plays normally on either side of a deleted word", () => {
    const deletedRanges = [{ startMs: 16_000, endMs: 16_800 }];
    expect(playbackActionForTime({ ...base, deletedRanges, ms: 15_900 }).kind).toBe("play");
    expect(playbackActionForTime({ ...base, deletedRanges, ms: 16_800 }).kind).toBe("play");
  });

  it("stops rather than skipping when a deleted word runs to the clip end", () => {
    const deletedRanges = [{ startMs: 23_000, endMs: 24_000 }];
    expect(playbackActionForTime({ ...base, deletedRanges, ms: 23_500 })).toEqual({
      kind: "stop",
      atMs: 24_000,
    });
  });

  it("pulls a position before the clip start forward", () => {
    expect(playbackActionForTime({ ...base, ms: 500 })).toEqual({ kind: "skip", toMs: 10_000 });
  });
});

describe("positionFromPointer", () => {
  const track = { left: 100, width: 400 };

  it("maps a click to the time under the pointer", () => {
    expect(positionFromPointer(300, track, 0, 20_000)).toBe(10_000);
  });

  it("clamps a pointer dragged past either edge", () => {
    expect(positionFromPointer(0, track, 0, 20_000)).toBe(0);
    expect(positionFromPointer(9_999, track, 0, 20_000)).toBe(20_000);
  });

  it("returns the view start for a zero-width track rather than dividing by zero", () => {
    expect(positionFromPointer(300, { left: 100, width: 0 }, 4_000, 8_000)).toBe(4_000);
  });
});

describe("msToTimecode", () => {
  it("formats under a minute", () => {
    expect(msToTimecode(0)).toBe("0:00");
    expect(msToTimecode(7_400)).toBe("0:07");
  });

  it("formats minutes and seconds", () => {
    expect(msToTimecode(65_000)).toBe("1:05");
    expect(msToTimecode(600_000)).toBe("10:00");
  });

  it("never shows a negative time", () => {
    expect(msToTimecode(-5_000)).toBe("0:00");
  });
});
