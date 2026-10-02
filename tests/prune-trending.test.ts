// Stored X posts judged again under the relevance rule (P1-10): Millie's only post on X was about a pet.
import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { persistRecords } from "../lib/persist";
import { applyTrendingPrune, planTrendingPrune } from "../lib/prune-trending";
import { record, testDb } from "./helpers";

describe("planTrendingPrune", () => {
  test("demotes a stored post that only shares a word with the company, keeps the round's own post and one it cannot judge", async () => {
    const db = await testDb();
    const r = record({
      company_name: "Millie",
      company_key: "millie",
      company_description: "a maternity care clinic",
      lead_investors: ["TMV", "Foreground"],
      amount: { value: 12, currency: "USD", as_written: "$12M", usd_millions: 12, fx_rate: 1, fx_date: "2026-09-22" },
      announced_date: "2026-09-22",
    });
    await persistRecords(db, [r], "series-a-b", "run-1");
    const post = (postKey: string, handle: string, authorName: string, snippet: string) => ({
      roundId: r.id,
      postKey,
      kind: "post",
      statusId: postKey,
      handle,
      authorName,
      url: `https://x.com/${handle}/status/${postKey}`,
      snippet,
      postedAt: new Date("2026-09-22T12:00:00Z"),
      relevant: true,
      nameHit: true,
    });
    await db.insert(schema.trendingPosts).values([
      post(
        "1",
        "pixie_tooth",
        "Pixie",
        "#OTLFP My Bestie Millie's mum discovered a raised lymph node on Millie's neck and took her to the vet",
      ),
      post("2", "syscreations", "SyS Creations", "Big news in maternity care! Millie just secured $12M in Series A"),
      // The company was named in the title this post was judged with, which the store does not keep.
      post("3", "jeremymburton", "Jeremy Burton", "a lot of founders are still ... $12M Series A - still hasn't launched product"),
    ]);
    const plan = await planTrendingPrune(db);
    expect(plan.checked).toBe(3);
    expect(plan.demote.map((d) => d.handle)).toEqual(["pixie_tooth"]);
    expect(await applyTrendingPrune(db, plan.demote)).toBe(1);
    expect((await planTrendingPrune(db)).demote).toEqual([]);
  });
});
