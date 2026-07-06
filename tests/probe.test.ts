import { describe, expect, it } from "vitest";
import { ProbeParseError, parseFfprobeOutput } from "@/lib/media/probe";

function fixture(overrides: Partial<{ streams: unknown[]; format: unknown }> = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        r_frame_rate: "30000/1001",
        avg_frame_rate: "30000/1001",
        duration: "180.033000",
      },
      { codec_type: "audio", sample_rate: "48000" },
    ],
    format: { duration: "180.033000" },
    ...overrides,
  });
}

describe("parseFfprobeOutput", () => {
  it("extracts duration, dimensions, fps, and audio presence", () => {
    const result = parseFfprobeOutput(fixture());

    expect(result.durationS).toBeCloseTo(180.033, 3);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.fps).toBeCloseTo(29.97, 2);
    expect(result.hasAudio).toBe(true);
  });

  it("reports no audio when only a video stream is present", () => {
    const result = parseFfprobeOutput(
      fixture({
        streams: [
          {
            codec_type: "video",
            width: 1280,
            height: 720,
            r_frame_rate: "25/1",
            duration: "60.000000",
          },
        ],
      }),
    );

    expect(result.hasAudio).toBe(false);
    expect(result.fps).toBe(25);
  });

  it("falls back to the video stream duration when format duration is missing", () => {
    const result = parseFfprobeOutput(
      fixture({ format: {} }),
    );

    expect(result.durationS).toBeCloseTo(180.033, 3);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => parseFfprobeOutput("not json")).toThrow(ProbeParseError);
  });

  it("throws when there is no video stream", () => {
    expect(() =>
      parseFfprobeOutput(JSON.stringify({ streams: [{ codec_type: "audio" }], format: {} })),
    ).toThrow(ProbeParseError);
  });

  it("throws when duration cannot be determined", () => {
    expect(() =>
      parseFfprobeOutput(
        JSON.stringify({ streams: [{ codec_type: "video", width: 100, height: 100 }], format: {} }),
      ),
    ).toThrow(ProbeParseError);
  });
});
