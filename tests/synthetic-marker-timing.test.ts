import { describe, expect, it } from "vitest";
import { compareSyntheticMarker, inspectSyntheticMarker } from "@/lib/evaluation/synthetic-marker-timing";

function fixture(event = 60, count = 120) {
  const probe = { format: { start_time: "0.000000" },
    streams: [{ width: 640, height: 360, start_time: "0.000000" }],
    frames: Array.from({ length: count }, (_, i) => ({ best_effort_timestamp_time: (i / 30).toFixed(6) })) };
  const pixels = Buffer.alloc(count * 192);
  for (let i = Math.max(0, event) * 192; i < pixels.length; i += 3) pixels[i] = 255;
  return { probe, pixels };
}
const mapping = { sourceStartMs: 1000, sourceEndMs: 3000, fixtureMarkerAtMs: 2000 };
const source = () => { const { probe, pixels } = fixture(); return inspectSyntheticMarker(probe, pixels, 80); };

describe("synthetic marker event observation", () => {
  it("compares the observed event in a declared range with measured frame tolerance", () => {
    const { probe, pixels } = fixture(30, 60);
    const range = inspectSyntheticMarker(probe, pixels, 80);
    expect(range).toMatchObject({ status: "observed", eventMs: 1000, probedFrameCount: 60, decodedFrameCount: 60,
      clocks: { containerStartMs: 0, videoStartMs: 0, firstFrameMs: 0 } });
    expect(compareSyntheticMarker(source(), range, mapping)).toMatchObject({ status: "matched",
      scope: "synthetic_marker_event_only", expectedEventMs: 1000, observedEventMs: 1000, deltaMs: 0, toleranceMs: 33.334 });
  });

  it("refuses a shifted event even when the declared interval is unchanged", () => {
    const { probe, pixels } = fixture(45, 60);
    const shifted = inspectSyntheticMarker(probe, pixels, 80);
    expect(compareSyntheticMarker(source(), shifted, mapping)).toMatchObject({ status: "mismatch",
      expectedEventMs: 1000, observedEventMs: 1500, deltaMs: 500, reason: "artifact_marker_timing_mismatch" });
  });

  it("does not accept a source and derivative with the same wrong event", () => {
    const { probe, pixels } = fixture(75);
    const wrong = inspectSyntheticMarker(probe, pixels, 80);
    expect(compareSyntheticMarker(wrong, wrong, { ...mapping, sourceStartMs: 0, sourceEndMs: 4000 }))
      .toMatchObject({ status: "mismatch", reason: "source_marker_timing_mismatch" });
  });

  it.each(["container", "video", "first_frame"])("preserves and refuses a nonzero %s clock", (clock) => {
    const { probe, pixels } = fixture();
    if (clock === "container") probe.format.start_time = "1.0";
    if (clock === "video") probe.streams[0].start_time = "1.0";
    if (clock === "first_frame") probe.frames[0].best_effort_timestamp_time = "0.1";
    const observed = inspectSyntheticMarker(probe, pixels, 80);
    expect(observed).toMatchObject({ status: "unavailable", reason: "unsupported_nonzero_start", eventMs: null });
    expect(Object.values(observed.clocks!)).toContain(clock === "first_frame" ? 100 : 1000);
    expect(compareSyntheticMarker(source(), observed, mapping).status).toBe("unavailable");
  });

  it.each(["N/A", "", "NaN", "Infinity"])("does not invent a timestamp from %s", (timestamp) => {
    const { probe, pixels } = fixture();
    probe.frames[60].best_effort_timestamp_time = timestamp;
    expect(inspectSyntheticMarker(probe, pixels, 80)).toMatchObject({ status: "unavailable", reason: "missing_or_invalid_probe" });
  });

  it("refuses a missing start clock or frame timestamp", () => {
    const { probe, pixels } = fixture();
    expect(inspectSyntheticMarker({ ...probe, format: {} }, pixels, 80).status).toBe("unavailable");
    expect(inspectSyntheticMarker({ ...probe, frames: [...probe.frames.slice(0, -1), {}] }, pixels, 80).status).toBe("unavailable");
  });

  it("refuses partial raw frames, count differences, and excessive probes", () => {
    const { probe, pixels } = fixture();
    for (const cropped of [pixels.subarray(1), pixels.subarray(192)]) {
      expect(inspectSyntheticMarker(probe, cropped, 80)).toMatchObject({ status: "unavailable", reason: "frame_count_mismatch" });
    }
    const long = fixture(60, 361);
    expect(inspectSyntheticMarker(long.probe, long.pixels, 80).status).toBe("unavailable");
  });

  it.each(["duplicate", "backward", "variable"])("refuses %s frame timestamps", (kind) => {
    const { probe, pixels } = fixture();
    probe.frames[60].best_effort_timestamp_time = kind === "duplicate" ? "1.966667" : kind === "backward" ? "1.0" : "2.01";
    expect(inspectSyntheticMarker(probe, pixels, 80)).toMatchObject({ status: "unavailable", reason: "unsupported_frame_cadence" });
  });

  it.each(["absent", "always", "flicker", "partial", "last"])("never matches an %s or ambiguous marker", (kind) => {
    const { probe, pixels } = fixture(kind === "absent" ? 120 : kind === "always" ? 0 : kind === "last" ? 119 : 60);
    if (kind === "flicker") pixels.fill(0, 80 * 192, 81 * 192);
    if (kind === "partial") for (let i = 59 * 192; i < 59 * 192 + 50 * 3; i += 3) pixels[i] = 255;
    const observed = inspectSyntheticMarker(probe, pixels, 80);
    expect(observed).toMatchObject({ status: "unavailable", eventMs: null,
      reason: kind === "absent" ? "marker_absent" : "marker_ambiguous" });
    expect(compareSyntheticMarker(source(), observed, mapping).status).toBe("unavailable");
  });

  it("requires the scaled fixture dimensions and an interval containing the event", () => {
    const { probe, pixels } = fixture();
    expect(inspectSyntheticMarker(probe, pixels, 40)).toMatchObject({ reason: "unsupported_dimensions" });
    probe.streams[0].width = 320; probe.streams[0].height = 180;
    expect(inspectSyntheticMarker(probe, pixels, 40)).toMatchObject({ status: "observed", crop: { width: 40, height: 40 } });
    expect(compareSyntheticMarker(source(), source(), { ...mapping, sourceStartMs: 2000 }).status).toBe("unavailable");
  });
});
