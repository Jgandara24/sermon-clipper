import { describe, expect, it } from "vitest";
import {
  calendarDateInTimezone,
  deriveServiceSlot,
  parseChurchProfile,
  targetClipCountFor,
  wallClockInstantInTimezone,
  type ChurchProfile,
} from "@/lib/church-profile";

describe("targetClipCountFor", () => {
  it("returns 6 for a once-a-week church", () => {
    expect(targetClipCountFor(1)).toBe(6);
  });

  it("returns 3 for a twice-a-week church", () => {
    expect(targetClipCountFor(2)).toBe(3);
  });
});

describe("parseChurchProfile", () => {
  it("fills in defaults when settings is empty", () => {
    expect(parseChurchProfile(null)).toEqual({
      timezone: "America/Chicago",
      serviceDay: "Sunday",
      sermonsPerWeek: 1,
      secondServiceDay: null,
      postsPerDay: 1,
    });
  });

  it("reads a fully-populated church profile", () => {
    const settings = {
      churchProfile: {
        timezone: "America/New_York",
        serviceDay: "Sunday",
        sermonsPerWeek: 2,
        secondServiceDay: "Wednesday",
        postsPerDay: 1,
      },
    };
    expect(parseChurchProfile(settings)).toEqual({
      timezone: "America/New_York",
      serviceDay: "Sunday",
      sermonsPerWeek: 2,
      secondServiceDay: "Wednesday",
      postsPerDay: 1,
    });
  });

  it("coerces an invalid sermonsPerWeek to the 1/week default", () => {
    const settings = { churchProfile: { sermonsPerWeek: 5 } };
    expect(parseChurchProfile(settings).sermonsPerWeek).toBe(1);
  });
});

describe("calendarDateInTimezone", () => {
  it("keeps the same calendar day when well within it", () => {
    const noonUtc = new Date("2026-07-19T18:00:00Z");
    expect(calendarDateInTimezone(noonUtc, "America/Chicago").toISOString()).toBe(
      "2026-07-19T00:00:00.000Z",
    );
  });

  it("rolls back to the prior calendar day near the UTC midnight boundary", () => {
    // 2am UTC on the 20th is still 9pm on the 19th in America/Chicago (CDT, UTC-5).
    const earlyUtc = new Date("2026-07-20T02:00:00Z");
    expect(calendarDateInTimezone(earlyUtc, "America/Chicago").toISOString()).toBe(
      "2026-07-19T00:00:00.000Z",
    );
  });
});

describe("deriveServiceSlot", () => {
  const twiceWeekly: ChurchProfile = {
    timezone: "America/Chicago",
    serviceDay: "Sunday",
    sermonsPerWeek: 2,
    secondServiceDay: "Wednesday",
    postsPerDay: 1,
  };

  it("classifies a Sunday sermon as PRIMARY", () => {
    const sunday = new Date("2026-07-19T18:00:00Z");
    expect(deriveServiceSlot(sunday, twiceWeekly)).toBe("PRIMARY");
  });

  it("classifies a Wednesday sermon as SECONDARY", () => {
    const wednesday = new Date("2026-07-22T18:00:00Z");
    expect(deriveServiceSlot(wednesday, twiceWeekly)).toBe("SECONDARY");
  });

  it("always returns PRIMARY for a once-a-week church regardless of weekday", () => {
    const onceWeekly: ChurchProfile = { ...twiceWeekly, sermonsPerWeek: 1, secondServiceDay: null };
    const wednesday = new Date("2026-07-22T18:00:00Z");
    expect(deriveServiceSlot(wednesday, onceWeekly)).toBe("PRIMARY");
  });
});

describe("wallClockInstantInTimezone", () => {
  it("converts 9am America/Chicago (CDT, UTC-5 in July) to the correct UTC instant", () => {
    const day = new Date("2026-07-20T00:00:00Z");
    expect(wallClockInstantInTimezone(day, 9, "America/Chicago").toISOString()).toBe(
      "2026-07-20T14:00:00.000Z",
    );
  });

  it("converts 9am UTC to itself", () => {
    const day = new Date("2026-07-20T00:00:00Z");
    expect(wallClockInstantInTimezone(day, 9, "UTC").toISOString()).toBe("2026-07-20T09:00:00.000Z");
  });
});
