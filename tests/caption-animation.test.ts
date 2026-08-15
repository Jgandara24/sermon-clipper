import { describe, expect, it } from "vitest";
import {
  overshootScale,
  POP_IN_MS,
  POP_SETTLE_MS,
  wordScaleAt,
} from "@/lib/editor/caption-animation";

describe("wordScaleAt", () => {
  it("starts at 1, overshoots at the pop peak, settles to the highlight scale", () => {
    const hs = 1.14;
    expect(wordScaleAt(0, hs)).toBe(1);
    expect(wordScaleAt(POP_IN_MS, hs)).toBeCloseTo(overshootScale(hs), 6);
    expect(wordScaleAt(POP_IN_MS + POP_SETTLE_MS, hs)).toBeCloseTo(hs, 6);
    expect(wordScaleAt(10_000, hs)).toBe(hs);
  });

  it("rises monotonically during pop-in and falls monotonically while settling", () => {
    const hs = 1.2;
    let prev = wordScaleAt(0, hs);
    for (let t = 5; t <= POP_IN_MS; t += 5) {
      const next = wordScaleAt(t, hs);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
    prev = wordScaleAt(POP_IN_MS, hs);
    for (let t = POP_IN_MS + 5; t <= POP_IN_MS + POP_SETTLE_MS; t += 5) {
      const next = wordScaleAt(t, hs);
      expect(next).toBeLessThanOrEqual(prev);
      prev = next;
    }
  });

  it("is a constant 1 for non-animating styles (highlightScale 1)", () => {
    for (const t of [0, 45, 90, 200, 5000]) {
      expect(wordScaleAt(t, 1)).toBe(1);
    }
  });

  it("never scales below 1 or above the overshoot", () => {
    const hs = 1.4;
    for (let t = 0; t <= 500; t += 10) {
      const s = wordScaleAt(t, hs);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(overshootScale(hs));
    }
  });
});
