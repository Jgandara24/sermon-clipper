import { describe, expect, it } from "vitest";
import { buildDefaultExportFilename } from "@/lib/export/filename";

describe("buildDefaultExportFilename", () => {
  it("slugifies series/project and clip title and appends yyyymmdd", () => {
    const filename = buildDefaultExportFilename({
      seriesOrProject: "Advent Series",
      clipTitle: "God's Faithfulness in the Storm!",
      date: new Date(2026, 6, 6),
    });
    expect(filename).toBe("advent-series-god-s-faithfulness-in-the-storm-20260706.mp4");
  });

  it("falls back to a safe slug for titles with no ascii alphanumerics", () => {
    const filename = buildDefaultExportFilename({
      seriesOrProject: "***",
      clipTitle: "!!!",
      date: new Date(2026, 0, 1),
    });
    expect(filename).toBe("clip-clip-20260101.mp4");
  });
});
