// Write a hand-checked profile for one company, clearing the old one in the same transaction:
//   pnpm replace-profile <company id> --note "why" [--website https://barq.com] [--refuse web.barq.app,other.com]
//                        [--unreadable barq.com] [--description "a payments and digital wallet app"]
// Without --website the company is left with none. Every host the old row refused stays refused,
// and the enrich lane never sees the company without a profile row, so a sweep cannot take it back
// to a namesake's site mid-repair (the clear-then-refill race lib/enrich.ts replaceProfile describes).

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { replaceProfile } from "../../lib/enrich.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const list = (name: string): string[] | undefined =>
  flag(name)
    ?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
const companyId = args[0];
const note = flag("note");
if (!companyId || companyId.startsWith("--") || !note) {
  console.error(
    'usage: pnpm replace-profile <company id> --note "why" [--website URL] [--refuse hosts] [--unreadable hosts] [--description text]',
  );
  process.exit(1);
}

const handle = await openStore();
const row = await replaceProfile(handle, companyId, {
  website: flag("website") ?? null,
  refuse: list("refuse"),
  unreadable: list("unreadable"),
  description: flag("description"),
  note,
});
console.log(
  `Replaced the profile of ${companyId}: website ${row.company_website ?? "none"}, refused ${row.refused_hosts.join(", ") || "none"}, unreadable ${row.unreadable_hosts.join(", ") || "none"}.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
