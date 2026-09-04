import { describe, expect, it } from "vitest";
import {
  FRAME_KEY_MS,
  FRAME_TILE_WIDTH_PX,
  frameKey,
  frameSlots,
  pendingFrameKeys,
  tileCountFor,
} from "@/lib/editor/frames";

describe("tileCountFor", () => {
  it("fits whole tiles across the row, never fewer than one", () => {
    expect(tileCountFor(640)).toBe(640 / FRAME_TILE_WIDTH_PX);
    expect(tileCountFor(700)).toBe(Math.round(700 / FRAME_TILE_WIDTH_PX));
    expect(tileCountFor(10)).toBe(1);
    expect(tileCountFor(0)).toBe(1);
  });
});

describe("frameKey", () => {
  it("rounds a time to the grid frames are cached on", () => {
    expect(frameKey(0)).toBe(0);
    expect(frameKey(FRAME_KEY_MS * 3 + FRAME_KEY_MS / 3)).toBe(FRAME_KEY_MS * 3);
    expect(frameKey(FRAME_KEY_MS * 3 + (FRAME_KEY_MS * 2) / 3)).toBe(FRAME_KEY_MS * 4);
  });
});

describe("frameSlots", () => {
  it("is the source time at the centre of each tile, on the cache grid", () => {
    // Six seconds over three tiles: centres at 1s, 3s, 5s.
    expect(frameSlots({ start: 0, end: 6_000 }, 3)).toEqual([1_000, 3_000, 5_000]);
  });

  it("lands on the grid so a window that shifts a little reuses what it has", () => {
    const before = frameSlots({ start: 0, end: 6_000 }, 3);
    const after = frameSlots({ start: 60, end: 6_060 }, 3);
    expect(after).toEqual(before);
  });

  it("is empty for a window with no width or no tiles", () => {
    expect(frameSlots({ start: 5, end: 5 }, 3)).toEqual([]);
    expect(frameSlots({ start: 0, end: 6_000 }, 0)).toEqual([]);
  });
});

describe("pendingFrameKeys", () => {
  it("is what the window needs that the cache does not have, in order, once each", () => {
    const cache = new Map<number, "ready" | "placeholder">([[1_000, "ready"]]);
    expect(pendingFrameKeys([1_000, 3_000, 5_000, 3_000], cache)).toEqual([3_000, 5_000]);
  });

  it("does not ask again for a frame that could not be produced", () => {
    const cache = new Map<number, "ready" | "placeholder">([[3_000, "placeholder"]]);
    expect(pendingFrameKeys([1_000, 3_000], cache)).toEqual([1_000]);
  });
});
