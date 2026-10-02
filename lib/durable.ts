// Pure helpers the durable backfills share. Workflow bodies import them, and a workflow body is
// bundled for the workflow runtime, where Node modules do not load: keep this file import-free.

/** Companies one backfill run works before it hands the rest to a fresh run, so no run's event log grows past a few hundred steps. */
export const BACKFILL_CHUNK = 12;

/**
 * How many companies one backfill run takes before handing the rest to a fresh run: twice the lanes,
 * never under BACKFILL_CHUNK. A run waits for its slowest company before the next run starts, so a
 * batch much smaller than the lanes would leave most of them idle; a batch much larger makes the
 * workflow log (replayed on every step) long.
 */
export function backfillChunk(concurrency: number): number {
  return Math.max(BACKFILL_CHUNK, concurrency * 2);
}

/** Deal targets round-robin into `lanes` lists, so each lane's order is fixed before any step runs. Pure. */
export function dealLanes<T>(items: T[], lanes: number): T[][] {
  const n = Math.max(1, Math.min(lanes, items.length || 1));
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => {
    out[i % n].push(item);
  });
  return out;
}
