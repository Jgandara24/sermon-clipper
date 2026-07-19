/**
 * Maps a clip's rank (1-indexed, best first) to its calendar posting date, per Pulpit
 * Engine's scheduling rule (docs/BUSINESS_OVERVIEW.md): the Nth-best clip posts N days
 * after the sermon date — rank 1 is the day after the sermon, rank 6 is six days after.
 * `sermonDate` must already be a calendar-date-normalized UTC midnight (see
 * calendarDateInTimezone in church-profile.ts) so this stays plain UTC date arithmetic.
 */
export function scheduledDateForRank(sermonDate: Date, rank: number): Date {
  const result = new Date(sermonDate);
  result.setUTCDate(result.getUTCDate() + rank);
  return result;
}
