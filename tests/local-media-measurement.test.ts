import { describe, expect, it } from "vitest";
import {
  compareLocalMedia, localMediaMeasurementInput, parseLocalMediaProbe,
  type LocalMediaMeasurementInput,
} from "@/lib/evaluation/local-media-measurement";

const videoProbe = () => parseLocalMediaProbe(JSON.stringify({
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080,
    avg_frame_rate: "30000/1001", start_time: "0.080", duration: "6" }],
  format: { duration: "6", start_time: "0.040", filename: "/private/source.mp4", tags: { title: "private title" } },
}));
const input: LocalMediaMeasurementInput = {
  sourceFile: "source.mp4", artifactFile: "range.mp4", artifactId: "fixture-range", kind: "range",
  sourceStartMs: 1500, sourceEndMs: 3500,
};

describe("local media measurements", () => {
  it("retains separate container and stream clocks without copying filenames or tags", () => {
    const probe = videoProbe();
    expect(probe).toMatchObject({ durationMs: 6000, containerStartMs: 40,
      video: { startMs: 80, durationMs: 6000, width: 1920, height: 1080 }, audio: null });
    expect(probe.video?.fps).toBeCloseTo(29.97003);
    expect(JSON.stringify(probe)).not.toMatch(/private|filename|tags/);
  });

  it("accepts audio-only artifacts and falls back to a measured stream duration", () => {
    const probe = parseLocalMediaProbe(JSON.stringify({
      streams: [{ codec_type: "audio", codec_name: "flac", duration: "2.125", sample_rate: "16000", channels: 1 }],
      format: { duration: "N/A" },
    }));
    expect(probe).toMatchObject({ durationMs: 2125, video: null,
      audio: { codec: "flac", sampleRateHz: 16000, channels: 1 } });
  });

  it("does not turn missing frame-rate evidence into a number", () => {
    const probe = parseLocalMediaProbe(JSON.stringify({
      streams: [{ codec_type: "video", avg_frame_rate: "0/0" }], format: { duration: "1" },
    }));
    expect(probe.video?.fps).toBeNull();
  });

  it.each([
    { streams: [], format: { duration: "1" } },
    { streams: [{ codec_type: "audio" }], format: { duration: "N/A" } },
    { streams: [{ codec_type: "video" }], format: { duration: "0" } },
  ])("refuses absent streams or unusable duration", (probe) => {
    expect(() => parseLocalMediaProbe(JSON.stringify(probe))).toThrow();
  });

  it("reports the duration difference while leaving content mapping unverified", () => {
    const source = { sha256: "a".repeat(64), bytes: 1000, probe: videoProbe(), inspectionWallMs: 1 };
    const artifact = { ...source, bytes: 200, probe: { ...source.probe, durationMs: 2040 } };
    const result = compareLocalMedia(input, source, artifact);
    expect(result.declaredMapping).toMatchObject({ expectedDurationMs: 2000, verification: "NOT_VERIFIED", provenance: "caller_declared" });
    expect(result.observations).toEqual({ durationDifferenceMs: 40, artifactToSourceByteRatio: 0.2, originalDimensionsPreserved: true });
    artifact.probe.durationMs = 2000;
    expect(compareLocalMedia(input, source, artifact).declaredMapping.verification).toBe("NOT_VERIFIED");
  });

  it("refuses a declared range beyond the source and a kind with no matching stream", () => {
    const source = { sha256: "a".repeat(64), bytes: 1000, probe: videoProbe(), inspectionWallMs: 1 };
    expect(() => compareLocalMedia({ ...input, sourceEndMs: 7000 }, source, source)).toThrow(/exceeds/);
    expect(() => compareLocalMedia({ ...input, kind: "audio" }, source, source)).toThrow(/stream/);
  });

  it.each([
    { sourceStartMs: -1 }, { sourceEndMs: 1500 }, { sourceStartMs: Infinity },
    { artifactId: "https://private.example/media" }, { kind: "final_pass" },
  ])("refuses invalid declarations", (change) => {
    expect(localMediaMeasurementInput.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
