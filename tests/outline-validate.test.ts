import { describe, expect, it } from "vitest";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";
import { OutlineGenerationError } from "@/lib/analysis/outline/types";
import { resolveSectionAnchors, type RawSectionAnchor } from "@/lib/analysis/outline/validate";

function makeSegments(count: number): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 2_000,
    endMs: (i + 1) * 2_000,
    text: `Sentence number ${i}.`,
  }));
}

function anchor(overrides: Partial<RawSectionAnchor>): RawSectionAnchor {
  return {
    type: "point",
    heading: "A point",
    summary: "What the point says.",
    startSegmentIdx: 0,
    endSegmentIdx: 0,
    confidence: 0.9,
    ...overrides,
  };
}

describe("resolveSectionAnchors", () => {
  it("resolves ordered anchors to timestamps and positions", () => {
    const segments = makeSegments(100);
    const sections = resolveSectionAnchors(
      [
        anchor({ type: "introduction", startSegmentIdx: 0, endSegmentIdx: 29 }),
        anchor({ startSegmentIdx: 30, endSegmentIdx: 69 }),
        anchor({ type: "conclusion", startSegmentIdx: 70, endSegmentIdx: 99 }),
      ],
      segments,
      [],
    );
    expect(sections.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(sections[0].startMs).toBe(0);
    expect(sections[1].startMs).toBe(30 * 2_000);
    expect(sections[2].endMs).toBe(100 * 2_000);
  });

  it("sorts out-of-order sections and trims overlaps in favor of the earlier section", () => {
    const segments = makeSegments(100);
    const sections = resolveSectionAnchors(
      [
        anchor({ startSegmentIdx: 50, endSegmentIdx: 99 }),
        anchor({ type: "introduction", startSegmentIdx: 0, endSegmentIdx: 59 }),
      ],
      segments,
      [],
    );
    expect(sections[0].type).toBe("introduction");
    expect(sections[0].endSegmentIdx).toBe(59);
    expect(sections[1].startSegmentIdx).toBe(60);
  });

  it("absorbs an uncovered gap into the preceding section", () => {
    const segments = makeSegments(100);
    const sections = resolveSectionAnchors(
      [
        anchor({ startSegmentIdx: 0, endSegmentIdx: 39 }),
        anchor({ startSegmentIdx: 50, endSegmentIdx: 99 }),
      ],
      segments,
      [],
    );
    expect(sections[0].endSegmentIdx).toBe(49);
  });

  it("leaves an excluded gap outside every section", () => {
    const segments = makeSegments(100);
    const sections = resolveSectionAnchors(
      [
        anchor({ startSegmentIdx: 0, endSegmentIdx: 39 }),
        anchor({ startSegmentIdx: 50, endSegmentIdx: 99 }),
      ],
      segments,
      [{ startMs: 40 * 2_000, endMs: 50 * 2_000, reason: "announcement" }],
    );
    expect(sections[0].endSegmentIdx).toBe(39);
    expect(sections[1].startSegmentIdx).toBe(50);
  });

  it("clamps anchors that fall outside the transcript", () => {
    const segments = makeSegments(50);
    const sections = resolveSectionAnchors(
      [anchor({ startSegmentIdx: -10, endSegmentIdx: 500 })],
      segments,
      [],
    );
    expect(sections[0].startSegmentIdx).toBe(0);
    expect(sections[0].endSegmentIdx).toBe(49);
  });

  it("throws when the outline misses too much of the sermon", () => {
    const segments = makeSegments(100);
    expect(() =>
      resolveSectionAnchors([anchor({ startSegmentIdx: 0, endSegmentIdx: 9 })], segments, []),
    ).toThrow(OutlineGenerationError);
  });

  it("throws when the model returns no sections", () => {
    expect(() => resolveSectionAnchors([], makeSegments(10), [])).toThrow(OutlineGenerationError);
  });
});
