import { SchedulePublishStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assessMissedReschedule,
  describeRescheduleRefusal,
  type RescheduleFacts,
  type RescheduleMissedRefusal,
} from "@/lib/schedule/reschedule-missed";

/**
 * Which dates a missed post may move to.
 *
 * Dates are the part of this worth a truth table. Every case starts from a move that is allowed
 * and breaks exactly one thing.
 */

/** 2026-09-09 is a Wednesday; 2026-09-13 is a Sunday. */
const TODAY = new Date(Date.UTC(2026, 8, 7));
const WEDNESDAY = new Date(Date.UTC(2026, 8, 9));
const SUNDAY = new Date(Date.UTC(2026, 8, 13));

function facts(overrides: Partial<RescheduleFacts> = {}): RescheduleFacts {
  return {
    slot: { publishStatus: SchedulePublishStatus.MISSED, clipId: "clip-1" },
    newDate: WEDNESDAY,
    churchToday: TODAY,
    dateAlreadyTaken: false,
    ...overrides,
  };
}

function expectRefusal(input: RescheduleFacts, reason: RescheduleMissedRefusal) {
  expect(assessMissedReschedule(input)).toEqual({ eligible: false, reason });
}

describe("moving a missed post", () => {
  it("permits a future weekday this church has free", () => {
    expect(assessMissedReschedule(facts())).toEqual({ eligible: true });
  });

  it.each([
    SchedulePublishStatus.NOT_STARTED,
    SchedulePublishStatus.IN_PROGRESS,
    SchedulePublishStatus.SUCCEEDED,
    SchedulePublishStatus.FAILED,
    SchedulePublishStatus.BLOCKED,
    SchedulePublishStatus.UNFILLED,
  ])("refuses a %s date, because only a missed one is rescheduled here", (publishStatus) => {
    expectRefusal(facts({ slot: { publishStatus, clipId: "clip-1" } }), "slot_not_missed");
  });

  /**
   * A detached history row: reanalysis regenerated the clip out from under it. Moving the date
   * would only give the church an empty day on a different afternoon.
   */
  it("refuses a date whose clip was regenerated away", () => {
    expectRefusal(
      facts({ slot: { publishStatus: SchedulePublishStatus.MISSED, clipId: null } }),
      "slot_has_no_clip",
    );
  });

  it("refuses a date that has already passed for this church", () => {
    expectRefusal(facts({ newDate: new Date(Date.UTC(2026, 8, 6)) }), "date_in_past");
  });

  /**
   * Today is allowed. `allocatePostingSlots` already rules that "a slot dated today is still
   * postable; only a strictly earlier date is missed", and an operator noticing a missed post on
   * the morning it should have gone out has a real reason to send it that afternoon.
   */
  it("permits today, which is not the past", () => {
    expect(assessMissedReschedule(facts({ newDate: TODAY }))).toEqual({ eligible: true });
  });

  it("refuses Sunday, which never receives a post", () => {
    expectRefusal(facts({ newDate: SUNDAY }), "date_is_sunday");
  });

  /**
   * The weekday is read in UTC on purpose: `newDate` is already the church's own calendar date
   * pinned to UTC midnight, and converting it again would report the previous day. A church in
   * Chicago choosing Monday must not have it read as the Sunday before.
   */
  it("reads the weekday off the stored calendar date, not through a second conversion", () => {
    // The Monday after that Sunday. In a negative-offset zone a second conversion would call
    // this Sunday and refuse it.
    const monday = new Date(Date.UTC(2026, 8, 14));
    expect(assessMissedReschedule(facts({ newDate: monday }))).toEqual({ eligible: true });
  });

  it("refuses a date this church already has a post booked for", () => {
    expectRefusal(facts({ dateAlreadyTaken: true }), "date_already_taken");
  });

  it("reports the slot's own state before anything about the date", () => {
    expectRefusal(
      facts({
        slot: { publishStatus: SchedulePublishStatus.SUCCEEDED, clipId: "clip-1" },
        newDate: SUNDAY,
        dateAlreadyTaken: true,
      }),
      "slot_not_missed",
    );
  });
});

describe("describeRescheduleRefusal", () => {
  it("gives every reason its own sentence", () => {
    const reasons: RescheduleMissedRefusal[] = [
      "slot_not_missed",
      "slot_has_no_clip",
      "date_in_past",
      "date_is_sunday",
      "date_already_taken",
    ];
    const messages = reasons.map(describeRescheduleRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });
});
