// No section may claim more than this share of the final set in the first pass — one
// hook-heavy introduction must not consume every slot. Not a quota: sections contribute only
// clips that earned their place on score, and leftover slots reopen to everyone in pass two.
const SECTION_SHARE_CAP = 0.4;

/**
 * Diversity-aware final selection (spec: "Selection behavior"). Greedy by score with a soft
 * per-section cap:
 * - pass 1 takes candidates in score order, skipping any whose section already holds its share
 *   of the set — this is the "diversity advantage" for underrepresented sections;
 * - pass 2 refills remaining slots from the skipped candidates, still in score order, so a
 *   genuinely strong section can contribute several clips when others have nothing better.
 * Weak clips are never promoted to fill a section — a section with no winner simply has none.
 */
export function selectWithSectionDiversity<
  T extends { total: number; startMs: number; sectionPosition: number | null },
>(candidates: T[], maxClips: number): T[] {
  const sorted = [...candidates].sort((a, b) => b.total - a.total || a.startMs - b.startMs);
  const perSectionCap = Math.max(2, Math.ceil(maxClips * SECTION_SHARE_CAP));

  const selected: T[] = [];
  const skipped: T[] = [];
  const perSection = new Map<number | null, number>();

  for (const candidate of sorted) {
    if (selected.length >= maxClips) break;
    const count = perSection.get(candidate.sectionPosition) ?? 0;
    if (count >= perSectionCap) {
      skipped.push(candidate);
      continue;
    }
    perSection.set(candidate.sectionPosition, count + 1);
    selected.push(candidate);
  }

  for (const candidate of skipped) {
    if (selected.length >= maxClips) break;
    selected.push(candidate);
  }

  // Global rank order: score descending, stable — identical everywhere this set is displayed.
  return selected.sort((a, b) => b.total - a.total || a.startMs - b.startMs);
}
