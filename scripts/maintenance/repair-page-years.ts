import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { getFirecrawl } from "../../lib/firecrawl.ts";
import { repairPageYears } from "../../lib/page-years.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const client = getFirecrawl();
// A cached copy up to a month old reads the same and costs no fetch.
const read = (url: string) =>
  client
    .scrape(url, { formats: ["markdown"], onlyMainContent: false, maxAge: 30 * 86_400_000 })
    .then((doc) => doc.markdown ?? null)
    .catch(() => null);
const changes = await repairPageYears(await openStore(), read, apply);
for (const row of changes) console.log(`${row.id}  ${row.from} -> ${row.to}${row.backToFeed ? "  back to the feed" : ""}`);
console.log(`${changes.length} rounds ${apply ? "re-dated" : "would be re-dated"} to the day their sources tell of.`);
if (apply) await invalidateScriptEntityPages();
await closeDb();
