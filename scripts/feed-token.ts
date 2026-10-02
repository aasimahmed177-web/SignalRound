// Mint a feed token and print the subscribable URLs.
//   pnpm feed-token -- --label "Slack #deals" [--preset series-a-b] [--origin https://feed.example.com]

import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { mintFeedToken } from "../lib/settings.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const preset = arg("--preset", "series-a-b");
// The printed URLs should be the ones this machine serves: APP_ORIGIN when set, else the dev port in use.
const origin = arg("--origin", process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`);
const handle = await openStore();
const token = await mintFeedToken(handle, arg("--label", "default"), preset);
console.log(`Token minted (shown once; stored hashed). Subscribe with:`);
for (const ext of ["rss", "atom", "json"]) console.log(`  ${origin}/feeds/${token}/${preset}.${ext}`);
await closeDb();
process.exit(0);
