import { describe, expect, it } from "vitest";
import { evaluateRenderOutputQc, renderQcDurationToleranceS, type RenderQcFacts, type RenderQcExpectation } from "@/lib/qc/render-output";

function check(durationS = 152, fps: number | null | undefined = 30, finalWordEndS = 151.9, enabled = true) {
  const facts: RenderQcFacts = { probe: { durationS, fps, width: 1080, height: 1920, hasAudio: true },
    probeError: null, bytes: 100, checksum: "synthetic-checksum", captionEvents: 2 };
  const expectation: RenderQcExpectation = { width: 1080, height: 1920, durationS: 152,
    durationToleranceS: renderQcDurationToleranceS(152), captionLines: 2,
    ...(enabled ? { completeMessageTiming: { finalWordEndS } } : {}),
  };
  return evaluateRenderOutputQc(facts, expectation);
}
describe("complete-message output evidence", () => {
  it("exposes the legacy five-percent gap without changing the disabled check", () => {
    expect(check(145, 30, 151.9, false).status).toBe("PASSED");
    expect(check(145).failures.map((c) => c.name)).toEqual(["completeMessageTiming"]);
  });
  it.each([24, 25, 30, 60, 120])( "accepts one frame of drift at %i fps after the final word", (fps) => {
    expect(check(152 - 1 / fps, fps).status).toBe("PASSED");
    expect(check(152 + 1 / fps, fps).status).toBe("PASSED");
    expect(check(152 - 1 / fps - 0.002, fps).status).toBe("FAILED");
    expect(check(152 + 1 / fps + 0.002, fps).status).toBe("FAILED");
  });
  it("refuses any shortfall before the last word ends", () => {
    expect(check(151.999, 30, 152).status).toBe("FAILED");
    expect(check(152, 30, 152).status).toBe("PASSED");
  });
  it.each([null, 0, -1, NaN, Infinity])("refuses missing or invalid fps %s", (fps) => {
    expect(check(152, fps).status).toBe("FAILED");
  });
  it("caps tolerance for low frame rates", () => {
    expect(check(152.102, 1).status).toBe("FAILED");
  });
  it.each([0, -1, NaN, Infinity, 152.001])("refuses invalid final-word evidence %s", (end) => {
    expect(check(152, 30, end).status).toBe("FAILED");
  });
  it.each([NaN, Infinity, 0, -1])("refuses invalid output duration %s", (duration) => {
    expect(check(duration).status).toBe("FAILED");
  });
});
