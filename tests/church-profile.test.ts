import { describe, expect, it } from "vitest";
import { parseChurchProfile, targetClipCountFor } from "@/lib/church-profile";

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
