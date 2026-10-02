// The gap-fill prompt names what the record is missing and lists the pages already read, so the
// agent looks past them instead of re-reading the source that left the gap.

import { describe, expect, test } from "vitest";
import { gapFillPrompt } from "./gapfill.ts";

describe("gap-fill prompt", () => {
  test("names what is missing and lists the pages already read", () => {
    const p = gapFillPrompt({
      company_name: "Gapco",
      stage_as_written: "Series A",
      known: { announced_date: null, amount_as_written: "$8M", lead_investors: [], company_website: null },
      source_urls: ["https://news.example/gapco"],
    });
    expect(p).toContain("Find the announcement date, the lead investor, the company website.");
    expect(p).toContain("Known so far: amount $8M.");
    expect(p).toContain("open these first: https://news.example/gapco");
  });
});
