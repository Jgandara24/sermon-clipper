export type SermonsPerWeek = 1 | 2;

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
    timeZone: timezone,
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
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(date);
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
