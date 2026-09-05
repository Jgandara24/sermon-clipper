import {
  calendarDateInTimezone,
  targetClipCountFor,
  weekdayNameInTimezone,
  type ChurchProfile,
  type ServiceSlot,
} from "@/lib/church-profile";

/**
 * P1.8: which calendar dates one service's clips post on.
 *
 * This is the rule `src/lib/scheduling.ts` gets wrong. `scheduledDateForRank` is plain
 * `sermonDate + rank` arithmetic with no weekday awareness, so a church that streams on any day
 * but Saturday eventually posts on a Sunday — which the product forbids (Rev2 §2.3).
 *
 * Pure and DB-free by design: the profile, the occurrence, the sermon date, "now", and the dates
 * already taken all arrive as arguments, so every rule below is table-testable without a database
 * or a clock. Nothing calls this yet. P1.9 is the first consumer and the old path stays live until
 * then, so this commit changes no production behaviour.
 */

/** Sunday never receives a post. This is the product's rule, not a church setting. */
const DARK_WEEKDAY = "Sunday";

/**
 * What the allocator decided about one rank. Only `SCHEDULED` should become a live calendar row;
 * the other two are facts an operator needs to see, not slots to quietly drop.
 */
export type PostingSlotState = "SCHEDULED" | "MISSED" | "COLLIDED";

/**
 * The only two profile fields allocation reads. Narrower than `ChurchProfile` on purpose: the
 * P0.7 project snapshot carries no `postsPerDay`, and the configured weekday names matter to
 * `deriveServiceSlot`, which has already run by the time a sermon reaches this module. A full
 * `ChurchProfile` still satisfies this.
 */
export type PostingScheduleProfile = Pick<ChurchProfile, "timezone" | "sermonsPerWeek">;

export type PostingSlot = {
  /** 1-indexed, best clip first. Ranks stay dense: rank 2 keeps its date if rank 1 is MISSED. */
  rank: number;
  /** The posting date as a UTC-midnight calendar date in the church's timezone. Never a Sunday. */
  date: Date;
  state: PostingSlotState;
};

export type AllocatePostingSlotsInput = {
  profile: PostingScheduleProfile;
  /** Which weekly service this sermon is. `UNMATCHED` allocates nothing — see below. */
  serviceSlot: ServiceSlot;
  /**
   * The sermon's calendar date, already normalised to UTC midnight — exactly what
   * `Project.sermonDate` holds (written by `calendarDateInTimezone` at project creation). It is
   * NOT re-converted here: running a stored calendar date through a timezone a second time moves
   * a west-of-UTC church back a day. Null for legacy projects created before the column existed.
   */
  sermonDate: Date | null;
  /** "Now", passed in rather than read, so the rule stays pure. */
  now: Date;
  /**
   * Calendar dates this workspace has already armed, from any project. The earliest-armed row
   * owns a date; a later sermon that wants it is reported as `COLLIDED` rather than moved.
   */
  reservedDates?: readonly Date[];
  /**
   * How many days this sermon posts on, when the caller knows better than the profile does. The
   * project snapshot stores its own `targetClipCount`, and a project must schedule the way it was
   * configured when it was created, so `analyze.ts` passes that rather than re-deriving from a
   * profile that may have changed. An `UNMATCHED` service still allocates nothing.
   */
  slotCount?: number;
};

/**
 * Drops any time component without moving the day. Callers pass a stored calendar date, so this
 * truncates in UTC rather than converting through a timezone — a conversion would shift the date.
 */
function toUtcCalendarDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** A calendar date as the `YYYY-MM-DD` key the collision check compares on. */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The next calendar day. Inputs are UTC-midnight dates, so this is plain UTC arithmetic. */
function nextDay(date: Date): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + 1);
  return result;
}

/**
 * How many daily posts one service owns: six when the church streams once a week, three for each
 * of two services. An unmatched service owns none — it is analyzed and held as reserve, never
 * scheduled automatically (Rev2 §2.3, "a special service is analyzed but is not scheduled
 * automatically").
 */
export function postingSlotCountFor(
  profile: PostingScheduleProfile,
  serviceSlot: ServiceSlot,
  slotCount?: number,
): number {
  // Checked before the override on purpose: reserve-only is a rule about the service, and no
  // caller-supplied count may schedule a service the church does not hold.
  if (serviceSlot === "UNMATCHED") return 0;
  if (slotCount !== undefined) return Math.max(0, Math.floor(slotCount));
  return targetClipCountFor(profile.sermonsPerWeek);
}

/**
 * Allocates one service's posting dates: start the day after the sermon, skip every Sunday, and
 * take the next N days.
 *
 * Two services a week interleave without either needing the other's dates — a Sunday sermon fills
 * Monday to Wednesday and a Wednesday sermon fills Thursday to Saturday. Configured day pairs that
 * sit closer together genuinely overlap, and that overlap surfaces as `COLLIDED` rather than being
 * silently resolved; the caller decides what to tell the operator.
 *
 * A date already past is `MISSED` and a date another project armed first is `COLLIDED`. Neither
 * shifts the ranks behind it: rank N keeps its own date whatever happened to rank N-1, so a late
 * upload loses the days it slept through instead of pushing a week of content back (Rev2 §2.3,
 * "a missed date is marked MISSED; later posts do not shift").
 */
export function allocatePostingSlots(input: AllocatePostingSlotsInput): PostingSlot[] {
  const { profile, serviceSlot, sermonDate, now, reservedDates = [], slotCount } = input;
  if (!sermonDate) return [];

  const count = postingSlotCountFor(profile, serviceSlot, slotCount);
  if (count === 0) return [];

  // `now` is a real instant, so it does convert: "today" must be the church's today, not UTC's.
  const today = calendarDateInTimezone(now, profile.timezone);
  const reserved = new Set(reservedDates.map(dateKey));
  const slots: PostingSlot[] = [];

  let cursor = toUtcCalendarDate(sermonDate);
  for (let rank = 1; rank <= count; rank++) {
    // Advance at least one day, then past any Sunday. The weekday is read in UTC because the
    // cursor is already the church's own calendar date pinned to UTC midnight — reading it in the
    // church's zone would apply that offset a second time and report the previous day.
    do {
      cursor = nextDay(cursor);
    } while (weekdayNameInTimezone(cursor, "UTC") === DARK_WEEKDAY);

    slots.push({ rank, date: new Date(cursor), state: stateFor(cursor, today, reserved) });
  }

  return slots;
}

/** A slot dated today is still postable; only a strictly earlier date is missed. */
function stateFor(date: Date, today: Date, reserved: Set<string>): PostingSlotState {
  if (date.getTime() < today.getTime()) return "MISSED";
  if (reserved.has(dateKey(date))) return "COLLIDED";
  return "SCHEDULED";
}
