import { describe, expect, it } from "vitest";
import {
  calendarDateInTimezone,
  deriveServiceSlot,
  isValidIanaTimezone,
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

  it("stays on the requested calendar day for far-west zones (UTC-10/-11)", () => {
    const day = new Date("2026-07-20T00:00:00Z");
    // 9am HST = 19:00Z the SAME day — the old hour/minute-only drift landed 24h early.
    expect(wallClockInstantInTimezone(day, 9, "Pacific/Honolulu").toISOString()).toBe(
      "2026-07-20T19:00:00.000Z",
    );
    expect(wallClockInstantInTimezone(day, 9, "Pacific/Pago_Pago").toISOString()).toBe(
      "2026-07-20T20:00:00.000Z",
    );
  });

  it("crosses to the previous UTC day for far-east zones", () => {
    const day = new Date("2026-07-20T00:00:00Z");
    // 9am JST is exactly midnight UTC of the same date.
    expect(wallClockInstantInTimezone(day, 9, "Asia/Tokyo").toISOString()).toBe(
      "2026-07-20T00:00:00.000Z",
    );
    // 9am AEST (winter, UTC+10) = 23:00Z the previous day.
    expect(wallClockInstantInTimezone(day, 9, "Australia/Sydney").toISOString()).toBe(
      "2026-07-19T23:00:00.000Z",
    );
    // 9am NZST (winter, UTC+12) = 21:00Z the previous day.
    expect(wallClockInstantInTimezone(day, 9, "Pacific/Auckland").toISOString()).toBe(
      "2026-07-19T21:00:00.000Z",
    );
  });

  it("respects DST on both sides of the year", () => {
    const january = new Date("2026-01-19T00:00:00Z");
    // CST (winter, UTC-6) vs the CDT case above.
    expect(wallClockInstantInTimezone(january, 9, "America/Chicago").toISOString()).toBe(
      "2026-01-19T15:00:00.000Z",
    );
    // AEDT (summer, UTC+11) and NZDT (summer, UTC+13).
    expect(wallClockInstantInTimezone(january, 9, "Australia/Sydney").toISOString()).toBe(
      "2026-01-18T22:00:00.000Z",
    );
    expect(wallClockInstantInTimezone(january, 9, "Pacific/Auckland").toISOString()).toBe(
      "2026-01-18T20:00:00.000Z",
    );
    // Honolulu observes no DST — identical offset in January.
    expect(wallClockInstantInTimezone(january, 9, "Pacific/Honolulu").toISOString()).toBe(
      "2026-01-19T19:00:00.000Z",
    );
  });
});

describe("timezone validation and fallback", () => {
  it("accepts anything Intl can resolve, rejects what would throw later", () => {
    expect(isValidIanaTimezone("America/Chicago")).toBe(true);
    expect(isValidIanaTimezone("US/Central")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    // Node's ICU resolves legacy abbreviations like CST; the invariant that matters is
    // only that a stored value can never make Intl throw downstream.
    expect(isValidIanaTimezone("CST")).toBe(true);
    expect(isValidIanaTimezone("Central")).toBe(false);
    expect(isValidIanaTimezone("not a timezone")).toBe(false);
  });

  it("falls back to UTC instead of throwing on a bad stored timezone", () => {
    const day = new Date("2026-07-20T00:00:00Z");

    expect(() => calendarDateInTimezone(day, "Central")).not.toThrow();
    expect(calendarDateInTimezone(day, "Central").toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(wallClockInstantInTimezone(day, 9, "Central").toISOString()).toBe(
      "2026-07-20T09:00:00.000Z",
    );

    const twiceWeekly: ChurchProfile = {
      timezone: "Central",
      serviceDay: "Sunday",
      sermonsPerWeek: 2,
      secondServiceDay: "Wednesday",
      postsPerDay: 1,
    };
    expect(() => deriveServiceSlot(day, twiceWeekly)).not.toThrow();
  });
});
