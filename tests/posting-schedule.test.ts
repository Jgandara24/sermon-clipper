import { describe, expect, it } from "vitest";
import type { ChurchProfile } from "@/lib/church-profile";
import {
  allocatePostingSlots,
  postingSlotCountFor,
  type PostingSlot,
} from "@/lib/schedule/posting-schedule";

const onceWeekly: ChurchProfile = {
  timezone: "America/Chicago",
  serviceDay: "Sunday",
  sermonsPerWeek: 1,
  secondServiceDay: null,
  postsPerDay: 1,
};

const twiceWeekly: ChurchProfile = {
  ...onceWeekly,
  sermonsPerWeek: 2,
  secondServiceDay: "Wednesday",
};

/** Well before every date under test, so nothing is MISSED unless a case asks for it. */
const EARLY_NOW = new Date("2020-01-01T00:00:00.000Z");

function datesOf(slots: PostingSlot[]): string[] {
  return slots.map((slot) => slot.date.toISOString().slice(0, 10));
}

describe("postingSlotCountFor", () => {
  it("gives a single-service church six posting days", () => {
    expect(postingSlotCountFor(onceWeekly, "PRIMARY")).toBe(6);
  });

  it("gives each of two weekly services three posting days", () => {
    expect(postingSlotCountFor(twiceWeekly, "PRIMARY")).toBe(3);
    expect(postingSlotCountFor(twiceWeekly, "SECONDARY")).toBe(3);
  });

  it("gives an unmatched service none — it is reserve, not a weekly service", () => {
    expect(postingSlotCountFor(onceWeekly, "UNMATCHED")).toBe(0);
    expect(postingSlotCountFor(twiceWeekly, "UNMATCHED")).toBe(0);
  });
});

describe("allocatePostingSlots", () => {
  it("fills Monday to Saturday from a Sunday sermon, and never posts on Sunday", () => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-07-19T00:00:00.000Z"), // Sunday
      now: EARLY_NOW,
    });

    expect(datesOf(slots)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
    ]);
    expect(slots.every((slot) => slot.state === "SCHEDULED")).toBe(true);
  });

  it("skips the Sunday in the middle of a mid-week church's six days", () => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-07-22T00:00:00.000Z"), // Wednesday
      now: EARLY_NOW,
    });

    // Thu Fri Sat, Sunday skipped, Mon Tue Wed.
    expect(datesOf(slots)).toEqual([
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
    ]);
  });

  it.each([
    ["Sunday", "2026-07-19", ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"]],
    ["Monday", "2026-07-20", ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-27"]],
    ["Tuesday", "2026-07-21", ["2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-27", "2026-07-28"]],
    ["Wednesday", "2026-07-22", ["2026-07-23", "2026-07-24", "2026-07-25", "2026-07-27", "2026-07-28", "2026-07-29"]],
    ["Thursday", "2026-07-23", ["2026-07-24", "2026-07-25", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"]],
    ["Friday", "2026-07-24", ["2026-07-25", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]],
    ["Saturday", "2026-07-25", ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]],
  ])("allocates six non-Sunday days for a %s single-service church", (day, sermon, expected) => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date(`${sermon}T00:00:00.000Z`),
      now: EARLY_NOW,
    });
    expect(datesOf(slots)).toEqual(expected);
  });

  it.each([
    // [primary day, primary sermon, primary dates, secondary day, secondary sermon, secondary dates]
    ["Sunday", "2026-07-19", ["2026-07-20", "2026-07-21", "2026-07-22"],
     "Wednesday", "2026-07-22", ["2026-07-23", "2026-07-24", "2026-07-25"]],
    ["Saturday", "2026-07-18", ["2026-07-20", "2026-07-21", "2026-07-22"],
     "Tuesday", "2026-07-21", ["2026-07-22", "2026-07-23", "2026-07-24"]],
    ["Monday", "2026-07-20", ["2026-07-21", "2026-07-22", "2026-07-23"],
     "Thursday", "2026-07-23", ["2026-07-24", "2026-07-25", "2026-07-27"]],
    ["Friday", "2026-07-24", ["2026-07-25", "2026-07-27", "2026-07-28"],
     "Tuesday", "2026-07-21", ["2026-07-22", "2026-07-23", "2026-07-24"]],
  ])(
    "splits three and three for a %s + %s two-service church",
    (primaryDay, primarySermon, primaryDates, secondDay, secondSermon, secondDates) => {
      // The configured day names are what deriveServiceSlot reads; allocation reads only the
      // sermon date and how many services the church holds. Both sermon dates below are the
      // named pair's own days.
      void primaryDay;
      void secondDay;
      const profile = twiceWeekly;

      expect(
        datesOf(
          allocatePostingSlots({
            profile,
            serviceSlot: "PRIMARY",
            sermonDate: new Date(`${primarySermon}T00:00:00.000Z`),
            now: EARLY_NOW,
          }),
        ),
      ).toEqual(primaryDates);

      expect(
        datesOf(
          allocatePostingSlots({
            profile,
            serviceSlot: "SECONDARY",
            sermonDate: new Date(`${secondSermon}T00:00:00.000Z`),
            now: EARLY_NOW,
          }),
        ),
      ).toEqual(secondDates);
    },
  );

  it("allocates nothing for an unmatched service", () => {
    expect(
      allocatePostingSlots({
        profile: twiceWeekly,
        serviceSlot: "UNMATCHED",
        sermonDate: new Date("2026-07-21T00:00:00.000Z"),
        now: EARLY_NOW,
      }),
    ).toEqual([]);
  });

  it("allocates nothing when the project has no sermon date", () => {
    expect(
      allocatePostingSlots({
        profile: onceWeekly,
        serviceSlot: "PRIMARY",
        sermonDate: null,
        now: EARLY_NOW,
      }),
    ).toEqual([]);
  });

  it("marks a date that has already passed MISSED, and does not shift the ranks behind it", () => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-07-19T00:00:00.000Z"),
      now: new Date("2026-07-23T15:00:00.000Z"), // Thursday, church-local
    });

    expect(slots.map((slot) => [slot.rank, slot.date.toISOString().slice(0, 10), slot.state])).toEqual([
      [1, "2026-07-20", "MISSED"],
      [2, "2026-07-21", "MISSED"],
      [3, "2026-07-22", "MISSED"],
      [4, "2026-07-23", "SCHEDULED"], // today is not missed
      [5, "2026-07-24", "SCHEDULED"],
      [6, "2026-07-25", "SCHEDULED"],
    ]);
  });

  it("marks a date another project armed first COLLIDED, and keeps the later ranks in place", () => {
    const slots = allocatePostingSlots({
      profile: twiceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-07-19T00:00:00.000Z"),
      now: EARLY_NOW,
      reservedDates: [new Date("2026-07-21T00:00:00.000Z")],
    });

    expect(slots.map((slot) => slot.state)).toEqual(["SCHEDULED", "COLLIDED", "SCHEDULED"]);
    expect(datesOf(slots)).toEqual(["2026-07-20", "2026-07-21", "2026-07-22"]);
  });

  // Project.sermonDate is already a church-local calendar date at UTC midnight. Converting it
  // again would move a west-of-UTC church back a day and post the whole week one day early.
  it("uses a stored calendar date as-is, without re-applying the church's offset", () => {
    const sunday = new Date("2026-07-19T00:00:00.000Z");
    for (const timezone of ["America/Chicago", "Pacific/Honolulu", "Asia/Tokyo", "UTC"]) {
      const slots = allocatePostingSlots({
        profile: { ...onceWeekly, timezone },
        serviceSlot: "PRIMARY",
        sermonDate: sunday,
        now: EARLY_NOW,
      });
      expect(datesOf(slots)[0]).toBe("2026-07-20");
    }
  });

  it("returns dates at UTC midnight, whatever time of day it is handed", () => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-07-19T18:45:00.000Z"),
      now: EARLY_NOW,
    });
    expect(slots[0].date.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("decides MISSED against the church's today, not UTC's", () => {
    // 03:00Z on the 24th is still the evening of the 23rd in Chicago, so the 23rd is not yet past.
    const args = {
      profile: onceWeekly,
      serviceSlot: "PRIMARY" as const,
      sermonDate: new Date("2026-07-19T00:00:00.000Z"),
      now: new Date("2026-07-24T03:00:00.000Z"),
    };
    expect(allocatePostingSlots(args).map((slot) => slot.state)).toEqual([
      "MISSED", "MISSED", "MISSED", "SCHEDULED", "SCHEDULED", "SCHEDULED",
    ]);
    expect(
      allocatePostingSlots({ ...args, profile: { ...onceWeekly, timezone: "UTC" } })
        .map((slot) => slot.state),
    ).toEqual(["MISSED", "MISSED", "MISSED", "MISSED", "SCHEDULED", "SCHEDULED"]);
  });

  it("crosses a spring-forward DST boundary without losing or repeating a day", () => {
    // US DST begins 2026-03-08. A 2026-03-04 Wednesday sermon posts across it.
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      now: EARLY_NOW,
    });
    expect(datesOf(slots)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-09", // Sunday 2026-03-08 skipped
      "2026-03-10",
      "2026-03-11",
    ]);
  });

  it("crosses a month and a year boundary", () => {
    const slots = allocatePostingSlots({
      profile: onceWeekly,
      serviceSlot: "PRIMARY",
      sermonDate: new Date("2026-12-30T00:00:00.000Z"), // Wednesday
      now: EARLY_NOW,
    });
    expect(datesOf(slots)).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-04", // Sunday 2027-01-03 skipped
      "2027-01-05",
      "2027-01-06",
    ]);
  });
});
