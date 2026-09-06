import { GeneratedClipStatus } from "@prisma/client";
import { RETAINED_CLIP_STATUSES } from "@/lib/analysis/clip-status";

/**
 * Which clip takes a rejected one's place.
 *
 * Kept pure and separate from the transaction that uses it, because "who is next" is a rule worth
 * reading on its own — and because the transaction around it is long enough that a bug in the
 * choosing would be hard to see there.
 *
 * The rule is deliberately dull: the best unused clip from the same sermon. Rank is the selector's
 * ordering, so the lowest rank still available is the next-best moment that service produced.
 */

export type ReserveCandidate = {
  id: string;
  rank: number;
  status: GeneratedClipStatus;
  startMs: number;
  endMs: number;
  /** True when a scheduled post already holds this clip. A slot's clip is not a reserve. */
  isScheduled: boolean;
};

export type ReserveRefusal = "NO_ELIGIBLE_RESERVE";

export type ReserveSelection =
  | { selected: ReserveCandidate }
  | { selected: null; reason: ReserveRefusal };

/**
 * Statuses a reserve may hold.
 *
 * Read from `RETAINED_CLIP_STATUSES` rather than written out here, because this set had the enum
 * exactly backwards until 2026-09-06. It held `KEPT` alone, on the reading that `SUGGESTED` meant
 * a candidate the selector produced and did not keep. `analyze.ts` writes `SUGGESTED` for every
 * candidate it *does* keep and nothing writes `KEPT` at all, so no reserve was ever promotable:
 * a replacement superseded the rejected clip, found nothing to put in its place, emptied the slot
 * and opened an `UNFILLED` exception — every time, for every real sermon.
 *
 * Every test agreed with the bug because every fixture set `KEPT` by hand. Pointing at the shared
 * constant is what stops the writer and this policy drifting apart again.
 *
 * `HIDDEN` is a person's "not this one", and `SUPERSEDED` has already been replaced out once.
 * Those two are the exclusions that were always meant.
 */
const PROMOTABLE_STATUSES: ReadonlySet<GeneratedClipStatus> = new Set(RETAINED_CLIP_STATUSES);

export function isPromotableReserve(
  candidate: ReserveCandidate,
  excludedClipIds: ReadonlySet<string>,
): boolean {
  if (excludedClipIds.has(candidate.id)) return false;
  if (candidate.isScheduled) return false;
  if (!PROMOTABLE_STATUSES.has(candidate.status)) return false;
  // A zero-length clip cannot be rendered, so promoting one would trade a bad clip for a broken
  // slot. Cheap to check here, and impossible to notice once it is three tables away.
  return candidate.endMs > candidate.startMs;
}

/**
 * The next clip in, or nothing.
 *
 * "Same project" is not a parameter: the caller passes one project's candidates, because a
 * replacement never reaches across sermons. A clip from another service is a different sermon on a
 * different day, and swapping one in would post a church's Easter message on a Tuesday in March.
 */
export function selectReserve(
  candidates: readonly ReserveCandidate[],
  options?: { excludeClipIds?: readonly string[] },
): ReserveSelection {
  const excluded = new Set(options?.excludeClipIds ?? []);
  const eligible = candidates.filter((candidate) => isPromotableReserve(candidate, excluded));

  if (eligible.length === 0) return { selected: null, reason: "NO_ELIGIBLE_RESERVE" };

  // Lowest rank wins; the id breaks a tie so the choice is deterministic rather than
  // dependent on the order the database happened to return.
  const best = eligible.reduce((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? a : b;
    return a.id < b.id ? a : b;
  });
  return { selected: best };
}
