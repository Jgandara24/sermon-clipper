import { describe, expect, it } from "vitest";
import { filterSermonCandidates, isLikelyNonSermonText } from "@/lib/analysis/sermon-boundary";

describe("isLikelyNonSermonText", () => {
  it("flags announcement and offering language without sermon cues", () => {
    expect(
      isLikelyNonSermonText("Please fill out a connect card and remember the offering boxes by the welcome desk."),
    ).toBe(true);
  });

  it("keeps sermon text even when it mentions worship", () => {
    expect(
      isLikelyNonSermonText("Romans 8 teaches us that worship is more than a song because Christ holds us."),
    ).toBe(false);
  });
});

describe("filterSermonCandidates", () => {
  it("removes likely non-sermon windows when sermon windows remain", () => {
    const candidates = [
      {
        startMs: 0,
        endMs: 30_000,
        text: "Stand and sing with the worship team while the giving kiosk is open.",
      },
      {
        startMs: 30_000,
        endMs: 60_000,
        text: "Turn with me to John 14 where Jesus gives peace to troubled hearts.",
      },
    ];

    expect(filterSermonCandidates(candidates)).toEqual([candidates[1]]);
  });

  it("falls back to original candidates if every window is flagged", () => {
    const candidates = [
      { startMs: 0, endMs: 30_000, text: "Announcements and connect card details." },
    ];

    expect(filterSermonCandidates(candidates)).toEqual(candidates);
  });
});
