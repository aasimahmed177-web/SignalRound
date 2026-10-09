// One article linked twice, as http and https (the homepage's curl sample listed Fortune's story twice),
// is one source on every public surface, is not linked twice when it arrives again, and the stored
// duplicates come off with a dry-run-first repair.

import { samePageKey } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { listRounds, persistRecords } from "../lib/persist";
import { dedupeRoundSources } from "../lib/source-dupes";
import { dedupeSources } from "../lib/source-order";
import { record, testDb } from "./helpers";

const FORTUNE = "fortune.com/2026/10/09/ultra-robotics-raises-50-million";

test("samePageKey and dedupeSources: scheme, www and a trailing slash name one page; https wins", () => {
  expect(samePageKey(`http://${FORTUNE}`)).toBe(samePageKey(`https://www.${FORTUNE}/`));
  expect(samePageKey(`https://${FORTUNE}?a=1`)).not.toBe(samePageKey(`https://${FORTUNE}`));
  const kept = dedupeSources([
    { url: `http://${FORTUNE}`, title: "Ultra raises" },
    { url: "https://ultra.example/news", title: null },
    { url: `https://www.${FORTUNE}/`, title: null },
  ]);
  expect(kept.map((s) => s.url)).toEqual(["https://ultra.example/news", `https://www.${FORTUNE}/`]);
});

test("a round lists the page once, a later reading does not link it again, and the repair removes a stored twin", async () => {
  const db = await testDb();
  const ultra = record({
    company_name: "Ultra",
    sources: [
      { url: `http://${FORTUNE}`, host: "fortune.com", title: "Ultra raises $50M" },
      { url: `https://${FORTUNE}`, host: "fortune.com", title: "Ultra raises $50M" },
    ],
  });
  await persistRecords(db, [ultra], "series-a-b", "run-1");
  await persistRecords(
    db,
    [{ ...ultra, sources: [{ url: `https://www.${FORTUNE}/`, host: "fortune.com", title: "Ultra raises $50M" }] }],
    "series-a-b",
    "run-2",
  );
  const linked = await db.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, ultra.id));
  expect(linked).toHaveLength(1);

  // A twin the store holds from before the write-time check.
  await db
    .insert(schema.sources)
    .values({ id: `https://${FORTUNE}`, url: `https://${FORTUNE}`, host: "fortune.com", title: "Ultra raises $50M" });
  await db.insert(schema.roundSources).values({ roundId: ultra.id, sourceId: `https://${FORTUNE}` });
  const { rows } = await listRounds(db, { ids: [ultra.id], includeReview: true });
  expect(rows[0]?.sources.map((s) => s.url)).toEqual([`https://${FORTUNE}`]);

  const plan = await dedupeRoundSources(db);
  expect(plan).toEqual([{ roundId: ultra.id, keep: `https://${FORTUNE}`, drop: [`http://${FORTUNE}`] }]);
  expect(await db.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, ultra.id))).toHaveLength(2);
  await dedupeRoundSources(db, true);
  expect((await db.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, ultra.id))).map((l) => l.sourceId)).toEqual([
    `https://${FORTUNE}`,
  ]);
  expect(await dedupeRoundSources(db, true)).toEqual([]);
});
