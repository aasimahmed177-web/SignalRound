// The lead-flag repair: rounds whose own pages name a lead the row lost. GOAT's Series F (a lead marker
// describing its firms in two kinds) and Impulse Space's Series C (a later article, confirmed alone,
// took off the investors its release names) are the production cases.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { applyLeadFlagRepair, planLeadFlagRepair } from "../lib/lead-flag-repair";
import { listRounds, persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

const RELEASE = "https://www.impulsespace.com/updates/series-c";
const ARTICLE = "https://spacenews.example/impulse-raises-20m";

describe("lead-flag repair", () => {
  test("Impulse Space: the release's lead and participants come back; a firm the last-read page names stays off", async () => {
    const db = await testDb();
    const lost = record({
      company_name: "Impulse Space",
      company_domain: "impulsespace.com",
      lead_investors: [],
      other_investors: [],
      sources: [
        { url: RELEASE, host: "impulsespace.com", title: "Impulse Space Secures $20 Million Series A" },
        { url: ARTICLE, host: "spacenews.example", title: "Impulse Space raises $20 million" },
      ],
    });
    await persistRecords(db, [lost], "growth", "run-1");
    // The last verdict read the article alone, as the stored verification records it.
    const verdict = { status: "confirmed", notes: [] as string[], url: ARTICLE, sources_listed: 1 };
    await db.update(schema.fundingRounds).set({ verification: verdict }).where(eq(schema.fundingRounds.id, lost.id));
    const release =
      "Impulse Space today announced it has raised $20 million in a Series A funding round. The round, led by Linse Capital, brings its total to $45 million.\n\nWith Linse Capital leading, the round also includes participation from new investor DFJ Growth, as well as returning investors Founders Fund.";
    const article = "Impulse Space has raised $20 million. Founders Fund, an earlier backer, declined to comment.";
    await db.insert(schema.pageSnapshots).values([
      { hash: "release", markdown: release },
      { hash: "article", markdown: article },
    ]);
    await db.insert(schema.pageSnapshotReads).values([
      {
        sourceUrl: RELEASE,
        snapshotHash: "release",
        rawExtraction: {
          rounds: [
            {
              company_name: "Impulse Space",
              amount_as_written: "$20 million",
              round_type_as_written: "Series A",
              evidence_quote: "Impulse Space today announced it has raised $20 million in a Series A funding round.",
              lead_investors: ["Linse Capital"],
              other_investors: ["DFJ Growth", "Founders Fund"],
            },
          ],
        },
      },
      { sourceUrl: ARTICLE, snapshotHash: "article" },
    ]);

    const [fix, ...rest] = await planLeadFlagRepair(db);
    expect(rest).toEqual([]);
    expect(fix).toMatchObject({
      roundId: lost.id,
      from: { leads: [], participants: [] },
      to: { leads: ["Linse Capital"], participants: ["DFJ Growth"] },
      raised: [],
      added: [
        { name: "Linse Capital", role: "lead", page: RELEASE },
        { name: "DFJ Growth", role: "participant", page: RELEASE },
      ],
    });

    expect(await applyLeadFlagRepair(db, [fix])).toEqual({ applied: [lost.id], stale: [] });
    const [row] = (await listRounds(db, { ids: [lost.id], includeReview: true })).rows;
    expect(row.lead_investors).toEqual(["Linse Capital"]);
    expect(row.other_investors).toEqual(["DFJ Growth"]);
    expect(await planLeadFlagRepair(db)).toEqual([]);
    // A plan read before the round changed is not written over it.
    expect(await applyLeadFlagRepair(db, [fix])).toEqual({ applied: [], stale: [lost.id] });
  });

  test("GOAT: firms a lead marker names after describing them in two kinds are raised to lead", async () => {
    const db = await testDb();
    const url = "https://techcrunch.com/2021/06/24/goat-series-f";
    const goat = record({
      company_name: "GOAT",
      lead_investors: ["funds & accounts advised by T. Rowe Price Associates"],
      other_investors: ["Park West Asset Management", "Franklin Templeton", "Sequoia Capital"],
      sources: [{ url, host: "techcrunch.com", title: "GOAT hits $3.7 billion valuation in Series F raise" }],
    });
    await persistRecords(db, [goat], "growth", "run-1");
    const markdown =
      "GOAT has raised $195 million in a Series F raise.\n\nThe raise was led by a handful of hedge funds and P/E firms including Park West Asset Management, Franklin Templeton and funds & accounts advised by T. Rowe Price Associates, Inc. Sequoia Capital also participated.";
    await db.insert(schema.pageSnapshots).values({ hash: "goat", markdown });
    await db.insert(schema.pageSnapshotReads).values({ sourceUrl: url, snapshotHash: "goat" });

    const plan = await planLeadFlagRepair(db);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.raised).toEqual(["Franklin Templeton", "Park West Asset Management"]);
    expect(plan[0]?.to.participants).toEqual(["Sequoia Capital"]);
  });
});
