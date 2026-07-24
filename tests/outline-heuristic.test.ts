import { describe, expect, it } from "vitest";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";
import {
  buildHeuristicOutline,
  buildSingleSectionOutline,
  detectHeuristicExclusions,
} from "@/lib/analysis/outline/heuristic";

function makeSegments(texts: Record<number, string>, count: number): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 2_000,
    endMs: (i + 1) * 2_000,
    text: texts[i] ?? `Plain sermon sentence number ${i} about the passage.`,
  }));
}

describe("buildHeuristicOutline", () => {
  it("splits at point markers and closing language, labeling sections by position", () => {
    const segments = makeSegments(
      {
        40: "Here's the first thing I want you to see this morning.",
        100: "My second point is where this gets personal.",
        160: "As I close, let me leave you with this.",
      },
      220,
    );
    const outline = buildHeuristicOutline(segments);
    expect(outline).not.toBeNull();
    expect(outline!.status).toBe("heuristic");
    expect(outline!.sections.map((s) => s.type)).toEqual([
      "introduction",
      "point",
      "point",
      "conclusion",
    ]);
    expect(outline!.sections.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    // Ordered and non-overlapping.
    for (let i = 1; i < outline!.sections.length; i += 1) {
      expect(outline!.sections[i].startMs).toBeGreaterThanOrEqual(outline!.sections[i - 1].endMs);
    }
    // Covers the full transcript.
    expect(outline!.sections[0].startMs).toBe(0);
    expect(outline!.sections[outline!.sections.length - 1].endMs).toBe(220 * 2_000);
  });

  it("returns null when transition signals are too thin for a multi-section outline", () => {
    expect(buildHeuristicOutline(makeSegments({}, 100))).toBeNull();
  });
});

describe("buildSingleSectionOutline", () => {
  it("always yields exactly one Main Message section covering the sermon", () => {
    const outline = buildSingleSectionOutline(makeSegments({}, 50));
    expect(outline.status).toBe("fallback_single");
    expect(outline.sections).toHaveLength(1);
    expect(outline.sections[0].type).toBe("main_message");
    expect(outline.sections[0].heading).toBe("Main Message");
    expect(outline.sections[0].startMs).toBe(0);
    expect(outline.sections[0].endMs).toBe(50 * 2_000);
  });
});

describe("detectHeuristicExclusions", () => {
  it("flags worship and invitation spans with their reasons and merges neighbors", () => {
    const segments = makeSegments(
      {
        2: "Please stand with the worship team as we sing together this morning.",
        3: "Keep singing that chorus one more time with the worship team.",
        90: "Would you bow your heads and close your eyes with me right now.",
      },
      100,
    );
    const exclusions = detectHeuristicExclusions(segments);
    const reasons = exclusions.map((e) => e.reason);
    expect(reasons).toContain("not_preaching");
    expect(reasons).toContain("invitation");
    // Segments 2 and 3 merge into one range.
    const worship = exclusions.find((e) => e.reason === "not_preaching");
    expect(worship!.startMs).toBe(2 * 2_000);
    expect(worship!.endMs).toBe(4 * 2_000);
  });

  it("does not flag plain preaching", () => {
    expect(detectHeuristicExclusions(makeSegments({}, 40))).toHaveLength(0);
  });
});
