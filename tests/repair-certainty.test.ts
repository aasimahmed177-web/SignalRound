import { describe, expect, test } from "vitest";
import { classifyStoredCertainty } from "../lib/repair-certainty.ts";

const now = new Date("2026-09-29T00:00:00Z");
function row(quote: string, firstSeen = "2026-09-28T00:00:00Z", host = "techcrunch.com") {
  return {
    evidence_quotes: [quote],
    sources: [{ url: `https://${host}/modal-round`, host, title: "Modal Labs funding report", published: "2026-09-28", query: null }],
    first_seen_at: firstSeen,
    announced_on: "2026-09-28",
    reported_on: null,
    amount: { as_written: "$750 million" },
    company: { name: "Modal Labs" },
  };
}

describe("existing-round certainty repair", () => {
  test("keeps Modal's reported pending round with its evidence sentence", () => {
    const quote = "Modal Labs is nearing a $750 million funding round led by Accel at a $15.75 billion valuation.";
    expect(classifyStoredCertainty(row(quote), undefined, now)).toMatchObject({
      certainty: "expected",
      quote,
      tiered: true,
      reportedOn: "2026-09-28",
    });
  });

  test("distinguishes an unnamed-source closing from an on-record closing", () => {
    expect(classifyStoredCertainty(row("Modal Labs raised $750 million, according to people familiar."), undefined, now).certainty).toBe(
      "reported",
    );
    expect(classifyStoredCertainty(row("Modal Labs announced it closed a $750 million round."), undefined, now).certainty).toBe(
      "announced",
    );
  });

  test("a later accepted close outranks an earlier expected report, using each source's own evidence", () => {
    const blue = {
      ...row("Blue Origin raises $10 billion in its first outside financing round."),
      amount: { as_written: "$10 billion" },
      company: { name: "Blue Origin" },
      sources: [
        {
          url: "https://www.wsj.com/blue-origin-seeks",
          host: "wsj.com",
          title: "Bezos’ Space Venture Blue Origin Seeks $10 Billion in Funding Round",
        },
        {
          url: "https://finance.yahoo.com/blue-origin-raises",
          host: "finance.yahoo.com",
          title: "Blue Origin raises $10 billion in first outside funding",
        },
        {
          url: "https://seekingalpha.com/blue-origin-raises",
          host: "seekingalpha.com",
          title: "Jeff Bezos's Blue Origin raises $10B at $140B valuation",
        },
      ],
    };
    const evidence = new Map([
      [blue.sources[0].url, "Blue Origin is working on a $10 billion funding round that would value the company at $130 billion."],
      [
        blue.sources[1].url,
        "Blue Origin raises $10 billion in its first outside financing round, valuing the business at about $140 billion.",
      ],
      [blue.sources[2].url, "Blue Origin has raised $10 billion in its first financing round involving outside investors."],
    ]);
    expect(classifyStoredCertainty(blue, undefined, now, evidence)).toMatchObject({
      certainty: "announced",
      quote: "Blue Origin raises $10 billion in its first outside financing round, valuing the business at about $140 billion.",
    });

    const micro = {
      ...row("Micro1 has raised a fresh funding round of more than $100 million, according to two people familiar with the deal."),
      amount: { as_written: "$100 million" },
      company: { name: "Micro1" },
      sources: [
        {
          url: "https://forbes.com/micro1",
          host: "forbes.com",
          title: "This 25-Year-Old Raised Over $100 Million For His AI Startup Micro1",
        },
        { url: "https://traded.co/micro1", host: "traded.co", title: "Micro1 Raises $100 Million At $4 Billion Valuation" },
      ],
    };
    expect(classifyStoredCertainty(micro, undefined, now, new Map([[micro.sources[0].url, micro.evidence_quotes[0]]]))).toMatchObject({
      certainty: "announced",
      quote: micro.sources[1].title,
    });
  });

  test("after 90 days without confirmation it remains visible only as unconfirmed and never trusts a forum", () => {
    expect(
      classifyStoredCertainty(row("Modal Labs is nearing a $750 million round.", "2026-06-01T00:00:00Z"), undefined, now).certainty,
    ).toBe("unconfirmed");
    expect(
      classifyStoredCertainty(row("Modal Labs reportedly raised $750 million.", undefined, "forum.example"), undefined, now),
    ).toMatchObject({
      certainty: "reported",
      tiered: false,
    });
  });

  test("does not borrow trust or a closing from an unrelated second source", () => {
    const uncertain = row("Modal Labs is nearing a $750 million round.", undefined, "forum.example");
    uncertain.sources.push({
      url: "https://techcrunch.com/modal-acquisition",
      host: "techcrunch.com",
      title: "Modal Labs announced an acquisition",
      published: "2026-09-28",
      query: null,
    });
    expect(classifyStoredCertainty(uncertain, undefined, now)).toMatchObject({ certainty: "expected", tiered: false });
    uncertain.sources[1].title = "Modal Labs seeks $750 million in financing";
    expect(classifyStoredCertainty(uncertain, undefined, now)).toMatchObject({ certainty: "expected", tiered: true });
  });
});
