import { captureErrorSafely } from "@/lib/observability/error-reporting";

export type SermonsPerWeek = 1 | 2;

/** Accepts anything Intl resolves — canonical IANA names plus aliases like US/Central. */
export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A bad stored timezone (free-text before validation existed) must degrade to UTC, not
 * throw — an Intl RangeError here would brick project creation and publishing for the
 * whole workspace. The bad value is reported so it can be fixed, not silently absorbed.
 */
function resolveTimezone(timezone: string): string {
  if (isValidIanaTimezone(timezone)) return timezone;
  console.error(`[church-profile] invalid workspace timezone "${timezone}"; falling back to UTC`);
  void captureErrorSafely(new Error(`Invalid workspace timezone: ${timezone}`), {
    source: "church-profile",
  });
  return "UTC";
}

export type ChurchProfile = {
  timezone: string;
  serviceDay: string;
  sermonsPerWeek: SermonsPerWeek;
  secondServiceDay: string | null;
  postsPerDay: number;
};

const DEFAULT_SERMONS_PER_WEEK: SermonsPerWeek = 1;
const DEFAULT_POSTS_PER_DAY = 1;

function coerceSermonsPerWeek(value: unknown): SermonsPerWeek {
  return value === 2 ? 2 : DEFAULT_SERMONS_PER_WEEK;
}

/**
 * Workspace.settings is a free-form JSON column; this reads the churchProfile
 * sub-object with the same defaults new workspaces are created with, so callers
 * never have to null-check each field individually.
 */
export function parseChurchProfile(settings: unknown): ChurchProfile {
  const churchProfile =
    settings && typeof settings === "object" && "churchProfile" in settings
      ? (settings as { churchProfile?: unknown }).churchProfile
      : null;

  const raw = (churchProfile && typeof churchProfile === "object" ? churchProfile : {}) as Record<
    string,
    unknown
  >;

  return {
    timezone: typeof raw.timezone === "string" ? raw.timezone : "America/Chicago",
    serviceDay: typeof raw.serviceDay === "string" ? raw.serviceDay : "Sunday",
    sermonsPerWeek: coerceSermonsPerWeek(raw.sermonsPerWeek),
    secondServiceDay: typeof raw.secondServiceDay === "string" ? raw.secondServiceDay : null,
    postsPerDay:
      typeof raw.postsPerDay === "number" && raw.postsPerDay > 0
        ? Math.floor(raw.postsPerDay)
        : DEFAULT_POSTS_PER_DAY,
  };
}

/**
 * Pulpit Engine's scheduling rule (docs/BUSINESS_OVERVIEW.md): a church that
 * streams once a week needs 6 days of clips from that single sermon; a church
 * that streams twice a week needs 3 days of clips from each sermon.
 */
export function targetClipCountFor(sermonsPerWeek: SermonsPerWeek): number {
  return sermonsPerWeek === 2 ? 3 : 6;
}

export type ServiceSlot = "PRIMARY" | "SECONDARY";

/**
 * Normalizes an instant to the calendar date (Y-M-D, midnight UTC) it falls on in the
 * given timezone. Doing this once, up front, means every later "add N days" is plain
 * UTC date arithmetic — no further timezone or DST handling required.
 */
export function calendarDateInTimezone(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return new Date(Date.UTC(year, month - 1, day));
}

function weekdayNameInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: resolveTimezone(timezone) }).format(
    date,
  );
}

/**
 * Classifies a sermon date as the church's primary or secondary weekly service by
 * comparing its weekday (in the church's own timezone) against serviceDay/secondServiceDay.
 * Falls back to PRIMARY for a once-a-week church, or when the date lands on neither
 * configured day (e.g. a sermon uploaded on an atypical day).
 */
export function deriveServiceSlot(date: Date, profile: ChurchProfile): ServiceSlot {
  if (profile.sermonsPerWeek !== 2 || !profile.secondServiceDay) return "PRIMARY";

  const weekday = weekdayNameInTimezone(date, profile.timezone).trim().toLowerCase();
  const secondDay = profile.secondServiceDay.trim().toLowerCase();
  return weekday === secondDay ? "SECONDARY" : "PRIMARY";
}

/**
 * The reverse of calendarDateInTimezone: given a calendar date and a wall-clock hour, returns
 * the actual UTC instant that hour represents in the given timezone (Tier 3 needs this to turn
 * a ScheduledPost's date-only scheduledDate into the real unix timestamp Meta's API requires).
 * Standard "guess, then correct by the observed offset" approach — exact for all real timezones
 * including DST transitions, without a timezone-database dependency.
 */
export function wallClockInstantInTimezone(
  calendarDate: Date,
  hour: number,
  timezone: string,
): Date {
  const safeTimezone = resolveTimezone(timezone);
  const desired = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
    hour,
  );

  // The correction must compare full wall-clock timestamps (date + time), not just the
  // time of day: for a UTC-10 zone the guess reads as 23:00 of the *previous* local day,
  // and an hour/minute-only drift would land 24 hours early. Two passes make the result
  // exact across DST transitions.
  let instant = new Date(desired);
  for (let pass = 0; pass < 2; pass++) {
    const observed = observedWallClockUtc(instant, safeTimezone);
    if (observed === desired) break;
    instant = new Date(instant.getTime() + (desired - observed));
  }
  return instant;
}

/** Reads an instant as a wall clock in the given timezone, encoded as a Date.UTC timestamp. */
function observedWallClockUtc(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}
