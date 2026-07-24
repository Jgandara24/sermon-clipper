import { describe, expect, it } from "vitest";
import { selectWithSectionDiversity } from "@/lib/analysis/semantic/selection";

function candidate(total: number, sectionPosition: number | null, startMs = total * 1_000) {
  return { total, sectionPosition, startMs };
}

describe("selectWithSectionDiversity", () => {
  it("keeps everything, score-ordered, when under the limit", () => {
    const selected = selectWithSectionDiversity(
      [candidate(70, 0), candidate(90, 1), candidate(80, 0)],
      18,
    );
    expect(selected.map((c) => c.total)).toEqual([90, 80, 70]);
  });

  it("prevents one section from consuming the whole set", () => {
    // Section 0 has ten 90s; section 1's best is 60. With max 6 and a 40% share cap, section 1
    // must still be represented even though every section-0 candidate outscores it.
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => candidate(90 - i, 0, i * 1_000)),
      candidate(60, 1, 100_000),
      candidate(55, 1, 110_000),
    ];
    const selected = selectWithSectionDiversity(candidates, 6);
    expect(selected).toHaveLength(6);
    const fromSectionOne = selected.filter((c) => c.sectionPosition === 1);
    expect(fromSectionOne.length).toBeGreaterThanOrEqual(2);
  });

  it("lets a strong section contribute extra clips when slots remain after pass one", () => {
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) => candidate(95 - i, 0, i * 1_000)),
      candidate(50, 1, 100_000),
    ];
    const selected = selectWithSectionDiversity(candidates, 6);
    // Pass 1: 3 from section 0 (cap = ceil(6*0.4) = 3) + 1 from section 1; pass 2 refills the
    // remaining 2 slots from section 0's skipped candidates.
    expect(selected.filter((c) => c.sectionPosition === 0)).toHaveLength(5);
    expect(selected.filter((c) => c.sectionPosition === 1)).toHaveLength(1);
  });

  it("never invents clips to fill a section quota", () => {
    const selected = selectWithSectionDiversity([candidate(90, 0)], 18);
    expect(selected).toHaveLength(1);
  });

  it("returns the final set in global rank order (score descending)", () => {
    const candidates = [
      candidate(70, 0, 1_000),
      candidate(95, 1, 2_000),
      candidate(85, 2, 3_000),
      candidate(80, 0, 4_000),
    ];
    const selected = selectWithSectionDiversity(candidates, 4);
    expect(selected.map((c) => c.total)).toEqual([95, 85, 80, 70]);
  });

  it("respects an arbitrary configured maximum, not a hardcoded pool size", () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(90 - i, i % 5, i * 1_000));
    expect(selectWithSectionDiversity(candidates, 7)).toHaveLength(7);
    expect(selectWithSectionDiversity(candidates, 21)).toHaveLength(21);
  });
});
