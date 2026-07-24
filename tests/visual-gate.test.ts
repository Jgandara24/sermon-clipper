import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyVisualGate,
  frameTimestamps,
  mergeSampleTimestamps,
  trimToVisibleRun,
  visualGateEnabled,
  visualGateRequired,
} from "@/lib/analysis/visual-gate";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ANALYSIS_VISUAL_GATE;
});

describe("frameTimestamps", () => {
  it("samples just inside the clip edges and through the middle", () => {
    const timestamps = frameTimestamps(10_000, 70_000);
    expect(timestamps[0]).toBeGreaterThanOrEqual(10_000);
    expect(timestamps[timestamps.length - 1]).toBeLessThanOrEqual(70_000);
    expect(timestamps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  it("samples densely enough that a ten-second gap cannot exist", () => {
    const timestamps = frameTimestamps(0, 60_000);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i] - timestamps[i - 1]).toBeLessThan(10_000);
    }
  });

  it("caps the frame count for long clips", () => {
    expect(frameTimestamps(0, 90_000).length).toBeLessThanOrEqual(24);
  });
});

describe("mergeSampleTimestamps", () => {
  it("adds scene-change points to the grid in time order", () => {
    const merged = mergeSampleTimestamps([0, 10_000, 20_000], [14_500]);
    expect(merged).toEqual([0, 10_000, 14_500, 20_000]);
  });

  it("drops near-duplicate timestamps", () => {
    const merged = mergeSampleTimestamps([0, 10_000], [10_400]);
    expect(merged).toEqual([0, 10_000]);
  });

  it("prioritizes scene-change points and clip edges when over the cap", () => {
    const grid = Array.from({ length: 24 }, (_, i) => i * 4_000);
    const scene = [50_500, 70_500];
    const merged = mergeSampleTimestamps(grid, scene, 24);
    expect(merged).toContain(50_500);
    expect(merged).toContain(70_500);
    expect(merged[0]).toBe(0);
    expect(merged[merged.length - 1]).toBe(92_000);
    expect(merged.length).toBeLessThanOrEqual(24);
  });
});

describe("visual gate environment policy", () => {
  it("is required only in production", () => {
    expect(visualGateRequired()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(visualGateRequired()).toBe(true);
  });

  it("honors the off switch outside production but ignores it in production", () => {
    process.env.ANALYSIS_VISUAL_GATE = "off";
    expect(visualGateEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(visualGateEnabled()).toBe(true);
  });
});

describe("trimToVisibleRun", () => {
  const clip = { startMs: 0, endMs: 60_000 };
  const frames = (visibility: boolean[]) =>
    visibility.map((visible, i) => ({ timestampMs: i * 10_000, visible }));

  it("passes an all-visible clip through untouched", () => {
    expect(trimToVisibleRun(clip, frames([true, true, true, true]), 20_000)).toEqual(clip);
  });

  it("rejects a clip where the preacher is never confirmed visible", () => {
    expect(trimToVisibleRun(clip, frames([false, false, false]), 20_000)).toBeNull();
  });

  it("trims to the longest visible run when the camera cuts away", () => {
    // Visible for frames 2..5 (20s–50s); the head of the clip loses the preacher.
    const trimmed = trimToVisibleRun(
      clip,
      frames([false, false, true, true, true, true]),
      20_000,
    );
    expect(trimmed).toEqual({ startMs: 20_000, endMs: 60_000 });
  });

  it("keeps the clip edge when the visible run touches it", () => {
    const trimmed = trimToVisibleRun(clip, frames([true, true, true, false]), 20_000);
    expect(trimmed).toEqual({ startMs: 0, endMs: 20_000 });
  });

  it("rejects when the longest visible run is shorter than the minimum duration", () => {
    expect(trimToVisibleRun(clip, frames([false, true, false, false]), 20_000)).toBeNull();
  });
});

describe("applyVisualGate", () => {
  const clips = [{ startMs: 0, endMs: 30_000 }];
  const fakeClient = {} as never;

  it("passes clips through untouched when disabled", async () => {
    const result = await applyVisualGate(clips, { kind: "path", path: "/tmp/x.mp4" }, {
      client: fakeClient,
      minMs: 20_000,
      enabled: false,
    });
    expect(result.status).toBe("skipped_disabled");
    expect(result.passed).toEqual(clips);
    expect(result.rejected).toHaveLength(0);
  });

  it("reports skipped_unavailable when there is no video to sample", async () => {
    const result = await applyVisualGate(clips, null, {
      client: fakeClient,
      minMs: 20_000,
      enabled: true,
    });
    expect(result.status).toBe("skipped_unavailable");
    expect(result.passed).toEqual(clips);
  });

  it("reports skipped_unavailable when there is no API client for vision", async () => {
    const result = await applyVisualGate(clips, { kind: "path", path: "/tmp/x.mp4" }, {
      client: null,
      minMs: 20_000,
      enabled: true,
    });
    expect(result.status).toBe("skipped_unavailable");
    expect(result.passed).toEqual(clips);
  });
});
