/**
 * The run's cost read off the account balance: remaining credits before the run minus after.
 * An unmetered key reports 0 at both reads: that is "unknown", not a free run. A metered key
 * reporting the same balance twice still reads 0, a real measurement of a run that spent nothing.
 */
export function measuredCredits(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  if (before === 0 && after === 0) return null;
  return before - after;
}
