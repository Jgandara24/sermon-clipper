import { describe, expect, it } from "vitest";
import { scheduledDateForRank } from "@/lib/scheduling";

describe("scheduledDateForRank", () => {
  const sunday = new Date("2026-07-19T00:00:00.000Z");

  it("schedules rank 1 the day after the sermon", () => {
    expect(scheduledDateForRank(sunday, 1).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("schedules rank 6 six days after a once-a-week sermon (the following Saturday)", () => {
    expect(scheduledDateForRank(sunday, 6).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("schedules rank 3 three days after a twice-a-week sermon", () => {
    const wednesday = new Date("2026-07-22T00:00:00.000Z");
    expect(scheduledDateForRank(wednesday, 3).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });
});
