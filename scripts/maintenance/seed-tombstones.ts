// Merge tombstones for the merges applied before round_merges existed (lib/tombstone-seed.ts):
//   pnpm seed-tombstones -- --dir ~/fireround-devdata            # dry run: reads only
//   pnpm seed-tombstones -- --dir ~/fireround-devdata --apply    # write
// Reads, in that folder: every *.applied.txt that is a `--apply` log ("merge <drop> into <keep>"), every
// fix file's `merge` entries (*.json), and every *merge-backup*/round_sources.csv (a backed-up row now
// gone from the store, paired with the one row that holds all of its sources). Each pair is checked
// against the store before its tombstone is written: the dropped row gone, the kept row there. Running
// it twice changes nothing.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import {
  backupPairs,
  backupSources,
  parseAppliedMerges,
  parseMergeFixes,
  type SeedPair,
  seedTombstones,
} from "../../lib/tombstone-seed.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const at = args.indexOf("--dir");
const dir = at >= 0 ? args[at + 1]?.replace(/^~(?=\/)/, process.env.HOME ?? "~") : undefined;
if (!dir) {
  console.error("--dir <folder with the fix logs and backups> is required");
  process.exit(1);
}

const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const pairs: SeedPair[] = [];
const lines: string[] = [];
for (const name of (await readdir(dir)).sort()) {
  const path = join(dir, name);
  if (name.endsWith(".applied.txt")) pairs.push(...parseAppliedMerges(await readFile(path, "utf8"), name));
  else if (name.endsWith(".json")) pairs.push(...parseMergeFixes(await readFile(path, "utf8"), name));
  else if (name.includes("merge-backup") && (await stat(path)).isDirectory()) {
    const csv = await readFile(join(path, "round_sources.csv"), "utf8").catch(() => null);
    if (!csv) continue;
    const found = await backupPairs(handle, backupSources(csv), name);
    pairs.push(...found.pairs);
    lines.push(...found.lines);
  }
}
console.log(`${pairs.length} merge record(s) read from ${dir}`);
const result = await seedTombstones(handle, pairs, { apply });
for (const line of [...lines, ...result.lines]) console.log(line);
console.log(
  `\n${result.written} tombstone(s) ${apply ? "written" : "planned"}, ${result.skipped + lines.length} skipped, ${result.refused} refused.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(result.refused > 0 ? 2 : 0);
