// The verifier's note lines as the Verified block shows them. Each case is a line shape one of the
// writers produces (records/correction.ts, prune-investors, repair, report, reject), taken from the
// live feed (2026-09-24), plus the remark and status lines that stay prose.

import { describe, expect, test } from "vitest";
import { parseNote, parseNotes } from "../lib/verifier-notes";

const view = (raw: string, investors: string[] = []) => {
  const p = parseNote(raw, investors);
  return p.kind === "change" ? { label: p.label, items: p.items, detail: p.detail } : { remark: p.text };
};

describe("parseNote", () => {
  test("a lead the verdict added, in the row's spelling of the firm", () => {
    expect(view("leads: Emergence Capital (verda.com)", ["Emergence", "Tesi"])).toEqual({
      label: "Lead added",
      items: [{ text: "Emergence", host: "verda.com" }],
      detail: null,
    });
    expect(view("leads: Coatue (dayonedc.com), Hillhouse (dayonedc.com)")).toEqual({
      label: "Leads added",
      items: [
        { text: "Coatue", host: "dayonedc.com" },
        { text: "Hillhouse", host: "dayonedc.com" },
      ],
      detail: null,
    });
    // A parenthesis that is part of the name is not a host; "(a source)" cites nothing.
    expect(view("leads: NeoVentures (Mashreq) (a source)").items).toEqual([{ text: "NeoVentures (Mashreq)", host: null }]);
    expect(view("leads: High-Tech Gründerfonds (HTGF) (sesamers.com)").items).toEqual([
      { text: "High-Tech Gründerfonds (HTGF)", host: "sesamers.com" },
    ]);
  });

  test("demotions and removals name who, and why for a removal", () => {
    expect(view("not leads: Palette Wealth Management (PWM)")).toEqual({
      label: "Now a participant",
      items: [{ text: "Palette Wealth Management (PWM)", host: null }],
      detail: null,
    });
    expect(view("not leads: Khosla Ventures, Founders Fund").label).toBe("Now participants");
    expect(view("not investors in this round: Blossom Capital, Credo Ventures")).toEqual({
      label: "Removed",
      items: [
        { text: "Blossom Capital", host: null },
        { text: "Credo Ventures", host: null },
      ],
      detail: "not in this round",
    });
    expect(view("not supported for this round: Goldman Sachs").detail).toBe("no source places them in this round");
  });

  test("a corporate suffix after a comma stays with its name", () => {
    expect(view("page leads: Landolt Securities, Inc.").items).toEqual([{ text: "Landolt Securities, Inc.", host: null }]);
  });

  test("stage and amount changes read old to new", () => {
    expect(view("stage Series A read as Pre-A (zeroth0.com)")).toEqual({
      label: "Stage",
      items: [{ text: "Series A → Pre-A", host: "zeroth0.com" }],
      detail: null,
    });
    expect(view("the page calls it an extension (Series A-2) (techcrunch.com)").items).toEqual([
      { text: "extension (Series A-2)", host: "techcrunch.com" },
    ]);
    expect(view("amount $5 million read as €4.35 million ($5 million) (eu-startups.com)").items).toEqual([
      { text: "$5 million → €4.35 million ($5 million)", host: "eu-startups.com" },
    ]);
    expect(view("amount none read as €400,000 (tech.eu)")).toEqual({
      label: "Amount added",
      items: [{ text: "€400,000", host: "tech.eu" }],
      detail: null,
    });
    expect(view("amount $800K not stated for this round")).toEqual({
      label: "Amount removed",
      items: [{ text: "$800K", host: null }],
      detail: "not stated for this round",
    });
  });

  test("a date says its precision only when it is not the day", () => {
    expect(view("date 2026-09-24 (week) read as 2026-09-23 (day, inquirer.com)").items).toEqual([
      { text: "2026-09-24 (week) → 2026-09-23", host: "inquirer.com" },
    ]);
    expect(view("date 2026-09-23 (week) read as 2026-09-23 (day, techstartups.com)").items).toEqual([
      { text: "2026-09-23, the exact day (was week)", host: "techstartups.com" },
    ]);
    expect(view("date 2026-08-25 (day) read as 2026-08-24 (week, ctvc.co)").items).toEqual([
      { text: "2026-08-25 → 2026-08-24 (week)", host: "ctvc.co" },
    ]);
    expect(view("date none (unknown) read as 2026-09-22 (day, sesamers.com)")).toEqual({
      label: "Date added",
      items: [{ text: "2026-09-22", host: "sesamers.com" }],
      detail: null,
    });
    // An ungraded day the verdict only confirmed.
    expect(view("date 2026-09-04 confirmed to the day (was week) (parlayx.com)").items).toEqual([
      { text: "2026-09-04, the exact day (was week)", host: "parlayx.com" },
    ]);
  });

  test("a repair's redate keeps its reason", () => {
    expect(view("date 2026-09-05 (day) read as 2026-05-21 (day, prnewswire.com): announced May 21 (PR Newswire dateline)")).toEqual({
      label: "Date",
      items: [{ text: "2026-09-05 → 2026-05-21", host: "prnewswire.com" }],
      detail: "announced May 21 (PR Newswire dateline)",
    });
  });

  test("headquarters, reports, and rejections", () => {
    expect(view("headquarters San Jose, California (finance.yahoo.com)").items).toEqual([
      { text: "San Jose, California", host: "finance.yahoo.com" },
    ]);
    expect(view("reported: the amount is the valuation")).toEqual({
      label: "Reported",
      items: [{ text: "the amount is the valuation", host: null }],
      detail: null,
    });
    expect(view("rejected: not a funding round").label).toBe("Rejected");
  });

  test("the remark and status lines stay prose, capitalized", () => {
    expect(view("Sources agree. The source names no lead or other investors for this round.")).toEqual({
      remark: "Sources agree. The source names no lead or other investors for this round.",
    });
    expect(view("no source could be read")).toEqual({ remark: "No source could be read" });
    expect(view("model error: timeout")).toEqual({ remark: "Model error: timeout" });
  });
});

describe("parseNotes", () => {
  test("changes keep their order; the remark comes after", () => {
    const { changes, remarks } = parseNotes([
      "date 2026-09-24 (week) read as 2026-09-23 (day, dealbreaker.com)",
      "leads: Foreground Capital (dealbreaker.com)",
      "The source states that the Series A was co-led by TMV and Foreground Capital.",
      "headquarters San Francisco (dealbreaker.com)",
    ]);
    expect(changes.map((c) => c.label)).toEqual(["Date", "Lead added", "HQ added"]);
    expect(remarks.map((r) => r.text)).toEqual(["The source states that the Series A was co-led by TMV and Foreground Capital."]);
  });
});
