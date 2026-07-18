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
