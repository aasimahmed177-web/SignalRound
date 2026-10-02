// Reviewer-maintained rules. The JSON files in rules/ are the committed seed: what a fresh
// clone starts with. Aliases taught from the review queue go to the alias_rules table, not
// back to the file, because a deployed filesystem is read-only and a redeploy would discard
// the edit anyway. Publisher tiers are still file-only; nothing writes them at runtime.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeCompanyKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";

const dir = () => path.join(process.cwd(), "rules");

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(dir(), name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** alias key -> canonical company key: the seed file merged with the table, the table winning on a key. */
export async function loadAliases(handle: Db): Promise<Record<string, string>> {
  const [seed, rows] = await Promise.all([readJson<Record<string, string>>("aliases.json", {}), handle.select().from(schema.aliasRules)]);
  const aliases = { ...seed };
  for (const row of rows) aliases[row.aliasKey] = row.canonicalKey;
  return aliases;
}

/** Teach the resolver that `alias` is `canonical`. A self-mapping or an empty key is nothing to teach. */
export async function saveAlias(handle: Db, alias: string, canonical: string): Promise<void> {
  const aliasKey = normalizeCompanyKey(alias);
  const canonicalKey = normalizeCompanyKey(canonical);
  if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) return;
  await handle
    .insert(schema.aliasRules)
    .values({ aliasKey, canonicalKey })
    .onConflictDoUpdate({ target: schema.aliasRules.aliasKey, set: { canonicalKey } });
}

export async function loadPublisherTiers(): Promise<Record<string, number>> {
  return readJson<Record<string, number>>("publisher-tiers.json", {});
}
