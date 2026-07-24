import { describe, expect, it } from "vitest";
import { applyVisualGate, frameTimestamps, trimToVisibleRun } from "@/lib/analysis/visual-gate";

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

  it("caps the frame count for long clips", () => {
    expect(frameTimestamps(0, 90_000).length).toBeLessThanOrEqual(8);
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
});
