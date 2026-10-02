// The stage vocabulary on its own, with no imports, so a client component (the feed's stage
// filter) can list the stages without pulling the Zod record schema into the browser bundle.
// schema.ts re-exports it, so the rest of the codebase reads STAGES from where it always has.

/** Normalized stage. `stage_as_written` keeps the page's own label beside it. */
export const STAGES = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d_plus",
  "growth",
  "bridge",
  "pre_a",
  "debt",
  "grant",
  "convertible",
  "secondary",
  "undisclosed",
  "other",
] as const;
export type Stage = (typeof STAGES)[number];
