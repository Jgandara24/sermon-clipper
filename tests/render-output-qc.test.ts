import { describe, expect, it } from "vitest";
import {
  evaluateRenderOutputQc,
  renderQcDurationToleranceS,
  type RenderQcExpectation,
  type RenderQcFacts,
} from "@/lib/qc/render-output";

const EXPECTATION: RenderQcExpectation = {
  width: 1080,
  height: 1920,
  durationS: 60,
  durationToleranceS: renderQcDurationToleranceS(60),
  captionLines: 12,
};

function facts(overrides: Partial<RenderQcFacts> = {}): RenderQcFacts {
  return {
    probe: { durationS: 60, width: 1080, height: 1920, hasAudio: true },
    probeError: null,
    bytes: 4_200_000,
    checksum: "a".repeat(64),
    captionEvents: 30,
    ...overrides,
  };
}

function failedNames(result: ReturnType<typeof evaluateRenderOutputQc>): string[] {
  return result.failures.map((check) => check.name);
}

describe("evaluateRenderOutputQc", () => {
  it("passes a render that decodes, carries both streams, and matches the expectation", () => {
    const result = evaluateRenderOutputQc(facts(), EXPECTATION);

    expect(result.status).toBe("PASSED");
    expect(result.failures).toEqual([]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails a file ffprobe could not read at all", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: null, probeError: "ffprobe output was not valid JSON." }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("decodes");
    // The reason ffprobe gave is kept, not swallowed.
    expect(result.failures[0].detail).toContain("valid JSON");
  });

  it("fails a file with no video stream, and says so", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: null, probeError: "ffprobe output did not include a video stream." }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(result.failures[0].detail).toContain("video stream");
  });

  it("fails a render with no audio stream", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: { durationS: 60, width: 1080, height: 1920, hasAudio: false } }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("hasAudio");
  });

  it("fails a render whose dimensions are not the expected vertical frame", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: { durationS: 60, width: 1920, height: 1080, hasAudio: true } }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("dimensions");
    expect(result.failures[0].detail).toContain("1920x1080");
  });

  it("fails a render whose dimensions ffprobe could not report", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: { durationS: 60, width: null, height: null, hasAudio: true } }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("dimensions");
  });

  it("fails a render that came out materially shorter than the edit asked for", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: { durationS: 41, width: 1080, height: 1920, hasAudio: true } }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("duration");
  });

  it("accepts the sub-second drift a re-encode normally introduces", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: { durationS: 60.4, width: 1080, height: 1920, hasAudio: true } }),
      EXPECTATION,
    );

    expect(result.status).toBe("PASSED");
  });

  it("scales the duration tolerance with the clip, so a short clip is not judged loosely", () => {
    expect(renderQcDurationToleranceS(4)).toBe(1);
    expect(renderQcDurationToleranceS(60)).toBe(3);
    expect(renderQcDurationToleranceS(600)).toBe(30);
  });

  it("fails a zero-byte file", () => {
    const result = evaluateRenderOutputQc(facts({ bytes: 0 }), EXPECTATION);

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("bytes");
  });

  it("fails a file with no checksum", () => {
    const result = evaluateRenderOutputQc(facts({ checksum: "   " }), EXPECTATION);

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("checksum");
  });

  it("fails a caption clip whose burn-in emitted nothing", () => {
    // The blank-caption render: the clip has caption lines, the file decodes, and every other
    // fact looks healthy, but no caption was drawn.
    const result = evaluateRenderOutputQc(facts({ captionEvents: 0 }), EXPECTATION);

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toContain("captionEvents");
  });

  it("does not require caption events from a clip that has no caption lines", () => {
    const result = evaluateRenderOutputQc(
      facts({ captionEvents: 0 }),
      { ...EXPECTATION, captionLines: 0 },
    );

    expect(result.status).toBe("PASSED");
  });

  it("reports every failing check, not only the first", () => {
    const result = evaluateRenderOutputQc(
      facts({
        probe: { durationS: 12, width: 640, height: 480, hasAudio: false },
        bytes: 0,
        checksum: "",
        captionEvents: 0,
      }),
      EXPECTATION,
    );

    expect(result.status).toBe("FAILED");
    expect(failedNames(result)).toEqual(
      expect.arrayContaining(["hasAudio", "dimensions", "duration", "bytes", "checksum", "captionEvents"]),
    );
  });

  it("reports every check it ran, passing and failing, for the stored record", () => {
    const result = evaluateRenderOutputQc(facts(), EXPECTATION);

    expect(result.checks.map((check) => check.name)).toEqual([
      "decodes",
      "dimensions",
      "hasAudio",
      "duration",
      "bytes",
      "checksum",
      "captionEvents",
    ]);
  });

  it("skips the checks that need a decoded file when the file did not decode", () => {
    const result = evaluateRenderOutputQc(
      facts({ probe: null, probeError: "unreadable" }),
      EXPECTATION,
    );

    // Reporting "no audio" and "wrong dimensions" for a file that never decoded would send the
    // reader after the wrong defect.
    expect(failedNames(result)).not.toContain("hasAudio");
    expect(failedNames(result)).not.toContain("dimensions");
    expect(failedNames(result)).not.toContain("duration");
  });
});
