// The sole-lead repair: a round whose one linked investor is stored as a participant while its page
// states the whole round's money as coming from it. Uscreen's $150 million from PSG is the production case.

import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { listRounds, persistRecords } from "../lib/persist";
import { applySoleLeadRepair, planSoleLeadRepair } from "../lib/sole-lead-repair";
import { record, testDb } from "./helpers";

describe("sole-lead repair", () => {
  test("Uscreen: the one investor its page names as the round's source is raised to lead; a round with two is left alone", async () => {
    const db = await testDb();
    const release = "https://psg.example/uscreen-150m";
    const uscreen = record({
      company_name: "Uscreen",
      amount: { value: 150, currency: "USD", as_written: "$150 million", usd_millions: 150, fx_rate: 1, fx_date: "2026-09-02" },
      lead_investors: [],
      other_investors: ["PSG"],
      sources: [{ url: release, host: "psg.example", title: "Uscreen announces $150 million investment from PSG" }],
    });
    const pair = record({
      company_name: "Pair Co",
      amount: { value: 150, currency: "USD", as_written: "$150 million", usd_millions: 150, fx_rate: 1, fx_date: "2026-09-02" },
      lead_investors: [],
      other_investors: ["PSG", "Beta Ventures"],
      sources: [{ url: "https://news.example/pair", host: "news.example", title: "Pair Co raises $150 million" }],
    });
    await persistRecords(db, [uscreen, pair], "growth", "run-1");
    await db.insert(schema.pageSnapshots).values([
      { hash: "uscreen", markdown: "Uscreen today announced a $150 million investment with PSG, a leading growth equity firm." },
      { hash: "pair", markdown: "Pair Co raised a $150 million investment from PSG. Beta Ventures also invested." },
    ]);
    await db.insert(schema.pageSnapshotReads).values([
      { sourceUrl: release, snapshotHash: "uscreen" },
      { sourceUrl: "https://news.example/pair", snapshotHash: "pair" },
    ]);

    const plan = await planSoleLeadRepair(db);
    expect(plan.map((f) => [f.roundId, f.investor])).toEqual([[uscreen.id, "PSG"]]);

    expect(await applySoleLeadRepair(db, plan)).toEqual({ applied: [uscreen.id], stale: [] });
    const rows = (await listRounds(db, { includeReview: true })).rows;
    expect(rows.find((r) => r.id === uscreen.id)).toMatchObject({ lead_investors: ["PSG"], other_investors: [] });
    expect(rows.find((r) => r.id === pair.id)?.lead_investors).toEqual([]);
    expect(await planSoleLeadRepair(db)).toEqual([]);
    expect(await applySoleLeadRepair(db, plan)).toEqual({ applied: [], stale: [uscreen.id] });
  });
});
