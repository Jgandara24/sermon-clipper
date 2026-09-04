import { describe, expect, it } from "vitest";
import {
  centredVideoBox,
  clampPanelWidths,
  PANEL_LIMITS,
  resizeDivider,
  VIDEO_MIN_PX,
} from "@/lib/editor/panel-resize";

const WIDE = 1600;

describe("clampPanelWidths", () => {
  it("holds each panel inside its own bounds", () => {
    const narrow = clampPanelWidths({ containerWidth: WIDE, transcript: 10, style: 10 });
    expect(narrow).toEqual({
      transcript: PANEL_LIMITS.transcript.min,
      style: PANEL_LIMITS.style.min,
    });

    const huge = clampPanelWidths({ containerWidth: WIDE, transcript: 9_000, style: 9_000 });
    expect(huge).toEqual({
      transcript: PANEL_LIMITS.transcript.max,
      style: PANEL_LIMITS.style.max,
    });
  });

  it("gives the video its minimum before the panels get what they asked for", () => {
    // A container too narrow for both panels at their maximum plus a usable video.
    const { transcript, style } = clampPanelWidths({
      containerWidth: 900,
      transcript: PANEL_LIMITS.transcript.max,
      style: PANEL_LIMITS.style.max,
    });

    expect(900 - transcript - style).toBeGreaterThanOrEqual(VIDEO_MIN_PX);
    expect(transcript).toBeGreaterThanOrEqual(PANEL_LIMITS.transcript.min);
    expect(style).toBeGreaterThanOrEqual(PANEL_LIMITS.style.min);
  });

  it("keeps the panels at their minimums rather than going negative in a tiny container", () => {
    const tiny = clampPanelWidths({ containerWidth: 200, transcript: 300, style: 300 });
    expect(tiny.transcript).toBe(PANEL_LIMITS.transcript.min);
    expect(tiny.style).toBe(PANEL_LIMITS.style.min);
  });
});

describe("resizeDivider", () => {
  const at = { containerWidth: WIDE, transcript: 300, style: 320 };

  it("moves only the panel its divider belongs to", () => {
    expect(resizeDivider({ ...at, divider: "transcript", deltaPx: 60 })).toEqual({
      transcript: 360,
      style: 320,
    });
    // The Style divider sits on the panel's left edge, so dragging right makes it narrower.
    expect(resizeDivider({ ...at, divider: "style", deltaPx: 60 })).toEqual({
      transcript: 300,
      style: 260,
    });
  });

  it("stops at the panel's own limits", () => {
    expect(resizeDivider({ ...at, divider: "transcript", deltaPx: 9_000 }).transcript).toBe(
      PANEL_LIMITS.transcript.max,
    );
    expect(resizeDivider({ ...at, divider: "transcript", deltaPx: -9_000 }).transcript).toBe(
      PANEL_LIMITS.transcript.min,
    );
  });

  it("stops before the video loses its minimum, however far the pointer travels", () => {
    const narrow = { containerWidth: 800, transcript: 240, style: 260 };
    const dragged = resizeDivider({ ...narrow, divider: "transcript", deltaPx: 9_000 });
    expect(800 - dragged.transcript - dragged.style).toBeGreaterThanOrEqual(VIDEO_MIN_PX);
  });
});

describe("centredVideoBox", () => {
  it("fills the column and pads nothing when the panels match", () => {
    const box = centredVideoBox({ containerWidth: WIDE, transcript: 300, style: 300 });
    expect(box).toEqual({ width: 1000, padLeft: 0, padRight: 0, centred: true });
  });

  it("puts the video's centre on the container's centre when the panels differ", () => {
    const transcript = 260;
    const style = 460;
    const box = centredVideoBox({ containerWidth: WIDE, transcript, style });

    expect(box.centred).toBe(true);
    // Absolute centre of the video, measured from the container's left edge.
    expect(transcript + box.padLeft + box.width / 2).toBe(WIDE / 2);
    // And it stays inside the column between the two panels.
    expect(box.padLeft).toBeGreaterThanOrEqual(0);
    expect(box.padRight).toBeGreaterThanOrEqual(0);
    expect(box.width + box.padLeft + box.padRight).toBe(WIDE - transcript - style);
  });

  it("is symmetric: swapping the panels mirrors the padding", () => {
    const left = centredVideoBox({ containerWidth: WIDE, transcript: 260, style: 460 });
    const right = centredVideoBox({ containerWidth: WIDE, transcript: 460, style: 260 });
    expect(left.width).toBe(right.width);
    expect(left.padLeft).toBe(right.padRight);
    expect(left.padRight).toBe(right.padLeft);
  });

  it("keeps the video usable rather than centred when centring would starve it", () => {
    // A wide Style panel against a narrow Transcript: centring would leave almost nothing.
    const box = centredVideoBox({ containerWidth: 820, transcript: 220, style: 300 });
    expect(box.width).toBeGreaterThanOrEqual(VIDEO_MIN_PX);
    expect(box.centred).toBe(false);
    expect(box.padLeft).toBe(0);
    expect(box.padRight).toBe(0);
  });

  it("never returns a negative or NaN box for a container with no width", () => {
    const box = centredVideoBox({ containerWidth: 0, transcript: 260, style: 260 });
    expect(box.width).toBe(0);
    expect(box.padLeft).toBe(0);
    expect(box.padRight).toBe(0);
  });
});
