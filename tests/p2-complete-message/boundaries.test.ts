import { describe, expect, it } from "vitest";
import { inspectProposal } from "./harness";
import { judgment, segmentRange, shortComplete, transcript } from "./fixtures";

describe("Stage 1 duration and padding", () => {
  it.each([
    [19_999, "below_generation_minimum"], [20_000, "supplied_message_complete"],
    [90_000, "supplied_message_complete"], [90_001, "supplied_message_complete"],
    [103_000, "supplied_message_complete"], [152_000, "supplied_message_complete"],
    [180_000, "supplied_message_complete"], [180_001, "message_exceeds_limit"],
  ])("checks %i milliseconds before padding", (duration, reason) => {
    const f = transcript([duration as number]);
    const result = inspectProposal(f.input, f.range, judgment(f.input));
    expect(result.reason).toBe(reason);
    if (result.range) {
      expect(result.range.startMs).toBeLessThanOrEqual(f.range.startMs);
      expect(result.range.endMs).toBeGreaterThanOrEqual(f.range.endMs);
      expect(result.range.endMs - result.range.startMs).toBeLessThanOrEqual(180_000);
    } else expect(result.state).toBe("rejected");
  });

  it("uses only 100 milliseconds of padding around 179,900 milliseconds of required speech", () => {
    const f = transcript([179_900]);
    expect(inspectProposal(f.input, f.range, judgment(f.input)).range).toEqual({
      startMs: f.offset - 100, endMs: f.offset + 179_900,
    });
  });

  it("keeps all required words at exactly 180 seconds and removes padding", () => {
    const f = transcript([180_000]);
    expect(inspectProposal(f.input, f.range, judgment(f.input)).range).toEqual(f.range);
  });

  it("adds 150 milliseconds at each safe edge", () => {
    const f = shortComplete();
    expect(inspectProposal(f.input, f.range, judgment(f.input)).range).toEqual({
      startMs: f.offset - 150, endMs: f.offset + 56_770,
    });
  });

  it("clamps padding to both source edges", () => {
    const f = transcript([30_000]);
    for (const segment of f.input.segments) {
      segment.startMs -= f.offset;
      segment.endMs -= f.offset;
      for (const word of segment.words) { word.startMs -= f.offset; word.endMs -= f.offset; }
    }
    f.input.sourceDurationMs = 30_000;
    f.input.regions = [{ startMs: 0, endMs: 30_000, kind: "allowed" }];
    const range = { startMs: 0, endMs: 30_000 };
    expect(inspectProposal(f.input, range, judgment(f.input)).range).toEqual(range);
  });

  it("does not pad into neighboring speech on either edge", () => {
    const f = transcript([5_000, 30_000, 5_000]);
    const range = segmentRange(f.input, 1, 1);
    expect(inspectProposal(f.input, range, judgment(f.input, [1])).range).toEqual(range);
  });

  it("uses only cleared region space for padding", () => {
    const f = transcript([30_000]);
    f.input.regions = [{ startMs: f.offset - 50, endMs: f.offset + 30_075, kind: "allowed" }];
    expect(inspectProposal(f.input, f.range, judgment(f.input)).range).toEqual({
      startMs: f.offset - 50, endMs: f.offset + 30_075,
    });
  });

  it.each([-1, 151, 1.5, NaN])("refuses invalid padding %s", (padding) => {
    const f = shortComplete();
    expect(inspectProposal(f.input, f.range, judgment(f.input), padding).reason).toBe("invalid_padding");
  });
});

describe("Stage 1 source and word limits", () => {
  it.each([undefined, 0, -1, NaN, Infinity, 1.5])("refuses invalid source duration %s", (duration) => {
    const f = shortComplete();
    f.input.sourceDurationMs = duration;
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("invalid_source");
  });

  it.each(["zero", "reversed", "negative", "fractional", "beyond"])("refuses a %s range", (kind) => {
    const f = shortComplete();
    const range = { ...f.range };
    if (kind === "zero") range.endMs = range.startMs;
    if (kind === "reversed") range.endMs = range.startMs - 1;
    if (kind === "negative") range.startMs = -1;
    if (kind === "fractional") range.startMs += 0.5;
    if (kind === "beyond") range.endMs = f.input.sourceDurationMs! + 1;
    expect(inspectProposal(f.input, range, judgment(f.input)).reason).toBe("invalid_range");
  });

  it("refuses source metadata shorter than the transcript", () => {
    const f = shortComplete();
    f.input.sourceDurationMs = f.range.endMs - 1;
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("invalid_segments");
  });

  it("refuses reversed transcript order", () => {
    const f = shortComplete();
    f.input.segments.reverse();
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("invalid_segments");
  });

  it("refuses repeated transcript identifiers", () => {
    const f = shortComplete();
    f.input.segments[1].id = f.input.segments[0].id;
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("duplicate_or_empty_id");
  });

  it.each(["overlap", "outside_segment"])("refuses %s word timestamps", (kind) => {
    const f = shortComplete();
    const segment = f.input.segments[0];
    if (kind === "overlap") segment.words[1].startMs = segment.words[0].endMs - 1;
    else segment.words[0].startMs = segment.startMs - 1;
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("invalid_words");
  });

  it("leaves missing boundary word times uncertain", () => {
    const f = shortComplete();
    f.input.segments[0].words = [];
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("boundary_uncertain");
  });

  it("does not accept a cut inside the next word", () => {
    const f = transcript([30_000, 20_000]);
    const range = { startMs: f.offset, endMs: f.offset + 30_001 };
    expect(inspectProposal(f.input, range, judgment(f.input, [0])).reason).toBe("boundary_uncertain");
  });

  it.each(["missing", "silence"] as const)("distinguishes a %s gap", (kind) => {
    const f = transcript([20_000, 20_000]);
    const second = f.input.segments[1];
    second.startMs += 500;
    for (const word of second.words) { word.startMs += 500; word.endMs += 500; }
    second.endMs += 500;
    f.range.endMs += 500;
    f.input.gaps = [{ startMs: f.offset + 20_000, endMs: f.offset + 20_500, kind }];
    const result = inspectProposal(f.input, f.range, judgment(f.input), 0);
    expect(result.state).toBe(kind === "missing" ? "uncertain" : "complete");
    if (kind === "missing") expect(result.reason).toBe("missing_coverage");
  });

  it("requires review when region clearance is unknown", () => {
    const f = shortComplete();
    f.input.regions = [{ ...f.range, kind: "uncertain" }];
    expect(inspectProposal(f.input, f.range, judgment(f.input)).reason).toBe("region_uncertain");
  });
});
