import { describe, expect, test } from "vitest";
import { classifyStage, stageWritten } from "../records/normalize.ts";
import { labelOnPage } from "./extract.ts";
import { groundQuotedPage, QuotedPage } from "./reader.ts";

describe("stageWritten", () => {
  test("a stage is written in its own words, in the languages the feed reads", () => {
    expect(stageWritten("series_a", "Atlas raised $15 million in a Series A led by Acme Ventures.")).toBe(true);
    expect(stageWritten("series_a", "Complaion chiude un round Serie A da 13,5 milioni.")).toBe(true);
    expect(stageWritten("series_a", "Atlas raised a $15 million A round.")).toBe(true);
    expect(stageWritten("series_a", "Atlas closed its Series A-1 at $15 million.")).toBe(true);
    expect(stageWritten("series_a", "Atlas\u306f\u30b7\u30ea\u30fc\u30baA\u30e9\u30a6\u30f3\u30c9\u3067\u8cc7\u91d1\u8abf\u9054")).toBe(
      true,
    );
    expect(stageWritten("series_d_plus", "Spectronix's round is an extension of its Series F financing.")).toBe(true);
    expect(stageWritten("seed", "Frank raised \u20ac2.9 million in a Seed-Runde.")).toBe(true);
    expect(stageWritten("pre_seed", "Nudge raised a $1.1M pre\u2011seed round.")).toBe(true);
    expect(stageWritten("growth", "Supabase has raised $150 million in growth equity led by GIC.")).toBe(true);
  });

  test("a sentence about this round's timing does not place the stage at an earlier round", () => {
    expect(stageWritten("seed", "Polygrade emerged from stealth with $6.3 million in previously unannounced seed funding.")).toBe(true);
    expect(stageWritten("series_b", "Prenetics plans to expand after raising a $40 million Series B led by Beyond Ventures.")).toBe(true);
  });

  test("a round written with no stage, or with another round's stage, does not write one", () => {
    expect(stageWritten("series_a", "Quanfluence has raised USD 10 million in a funding round led by Chiratae Ventures.")).toBe(false);
    expect(stageWritten("series_a", "Atlas raised $15 million in a round led by Acme Ventures.")).toBe(false);
    expect(stageWritten("series_a", "Matter Machine raised \u00a34 million in a pre-Series A round.")).toBe(false);
    expect(stageWritten("seed", "Elita previously raised a $1.1 million pre-seed round.")).toBe(false);
    expect(stageWritten("seed", "Nudge raised a $1.1M pre\u2011seed round.")).toBe(false);
    expect(stageWritten("series_a", "The financing exceeds Biotia's previously announced Series A.")).toBe(false);
    expect(stageWritten("series_a", "This \u20ac8.5 million funding round, ahead of its Series A, was led by UVC Partners.")).toBe(false);
    expect(stageWritten("growth", "The investment will support the company's next phase of growth.")).toBe(false);
  });

  test("a stage with no words of its own has nothing to check", () => {
    expect(stageWritten("other", "Kanu AI today announced $11.7 million in funding.")).toBe(true);
    expect(stageWritten("bridge", "Blitz raised Rs 28.70 crore.")).toBe(true);
  });
});

test("a pre-seed label written with a non-breaking hyphen is a pre-seed, not a seed", () => {
  expect(classifyStage("pre\u2011seed")).toEqual({ stage: "pre_seed", isExtension: false });
  expect(classifyStage("A$750k Pre\u2011Seed")).toEqual({ stage: "pre_seed", isExtension: false });
});

describe("labelOnPage", () => {
  test("a label the page writes only for an earlier round becomes the sentence's word", () => {
    const evidence = "Biotia, the clinical metagenomics company, today announced an oversubscribed $9 million financing.";
    const page = `${evidence} The financing exceeds Biotia's previously announced Series A and adds two board members.`;
    expect(labelOnPage("Series A extension", evidence, page)).toBe("financing");
  });

  test("a lettered label on a release that names no stage becomes the sentence's word", () => {
    const quanfluence = "Quanfluence has raised USD 10 million in a funding round led by Chiratae Ventures.";
    const release = `${quanfluence} Pi Ventures, an existing investor, returned as co-investor.`;
    expect(labelOnPage("Series A", quanfluence, release)).toBe("funding round");
    const complaion = "Complaion ha chiuso un round di finanziamento da 13,5 milioni di euro guidato da Eurazeo.";
    expect(labelOnPage("Series A", complaion, complaion)).toBe("round");
  });

  test("a seed label on a page that names only an earlier pre-seed becomes the sentence's word", () => {
    const evidence = "Dog health startup Elita has raised $1.9 million to expand its preventative care platform.";
    const page = `${evidence} Elita previously raised a $1.1 million pre-Seed round in July 2025.`;
    expect(labelOnPage("Seed", evidence, page)).toBe("funding round");
  });

  test("a URL slug is not the page's text", () => {
    const evidence = "Kairon Health today announced $5 million in venture funding.";
    const page = `# [Kairon Health Raises $5 Million](https://www.kaironhealth.com/news/kairon-health-raises-5-million-seed-round)\n\n${evidence} The round was led by Flare Capital Partners.\nhttps://example.com/news/kairon-seed`;
    expect(labelOnPage("Seed", evidence, page)).toBe("funding");
  });

  test("a growth label on a page that never writes a growth round becomes the sentence's word", () => {
    const evidence = "HighLife SAS today announced the successful completion of a $90+ Million (\u20ac80 Million) financing round.";
    const page = `${evidence} The funds will support the next phase of growth, including a US pivotal study.`;
    expect(labelOnPage("Growth round", evidence, page)).toBe("financing round");
    expect(labelOnPage("growth financing", evidence, page)).toBe("financing round");
  });

  test("a stage the page writes for this round stands, in whatever sentence it sits", () => {
    const alan = "Alan has reached unicorn status after it secured a massive new funding round.";
    const alanPage = `${alan}\nThe Paris-based company raised \u20ac185 million ($223 million) in a Series D funding round led by Coatue.`;
    expect(labelOnPage("Series D", alan, alanPage)).toBe("Series D");
    const chiplytics = "Chiplytics today announced a $4.5 million funding round led by Scout Ventures and Waypoint Ventures.";
    const chipPage = `${chiplytics} The $4.5 million includes $2.5 million in seed financing and a $2 million Air Force award.`;
    expect(labelOnPage("seed", chiplytics, chipPage)).toBe("seed");
    const corgi = "Insurance startup Corgi reportedly raised more money at $4B.";
    const corgiPage = `${corgi} The round is said to be a second extension of its Series B round and has already closed.`;
    expect(labelOnPage("a second extension of its Series B round", corgi, corgiPage)).toBe("a second extension of its Series B round");
    const xige = "Xige Estate has secured nearly RMB100 million in new funding from Tiansong Construction Group.";
    expect(labelOnPage("Series A+", xige, `${xige} The deal is understood to be part of Xige's Series A+ financing round.`)).toBe(
      "Series A+",
    );
    const supabase = "Supabase has raised $150 million in growth equity led by GIC.";
    expect(labelOnPage("growth equity", supabase, supabase)).toBe("growth equity");
  });
});

describe("groundQuotedPage: the stage quote must state the label's stage", () => {
  const reading = (partial: { company: string; label: string; evidence: string; stageQuote: string }) => ({
    company_name: partial.company,
    company_website: null,
    company_description: null,
    round_type_as_written: partial.label,
    amount_as_written: null,
    amount_kind: "round" as const,
    amount_scope: null,
    financing_total_as_written: null,
    financing_total_quote: null,
    valuation_as_written: null,
    valuation_quote: null,
    debt_quote: null,
    lead_investors: [],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: partial.evidence,
    source_url: null,
    is_background: false,
    is_rumor: false,
    field_quotes: {
      company: partial.evidence,
      website: null,
      description: null,
      stage: partial.stageQuote,
      amount: null,
      financing_total: null,
      valuation: null,
      date: null,
      headquarters: null,
      sector: null,
      lead_investors: [],
      other_investors: [],
    },
  });
  const label = (rounds: ReturnType<typeof reading>[], markdown: string) =>
    groundQuotedPage(QuotedPage.parse({ page_kind: "article", page_date: null, rounds }), markdown).rounds.map(
      (r) => r.round_type_as_written,
    );

  test("a quote on the page that writes no stage keeps no stage", () => {
    const evidence = "Kairon Health, the AI-native execution layer for value-based care, today announced $5 million in venture funding.";
    const markdown = `${evidence} The round was led by Flare Capital Partners.`;
    expect(label([reading({ company: "Kairon Health", label: "Seed", evidence, stageQuote: evidence })], markdown)).toEqual([
      "funding round",
    ]);
  });

  test("a stage the quote places at an earlier round keeps no stage", () => {
    const evidence = "Biotia today announced an oversubscribed $9 million financing.";
    const stageQuote = "The financing exceeds Biotia's previously announced Series A.";
    const markdown = `${evidence} ${stageQuote}`;
    expect(label([reading({ company: "Biotia", label: "Series A extension", evidence, stageQuote })], markdown)).toEqual(["funding round"]);
  });

  test("on a roundup, another company's line is not this round's stage", () => {
    const voltaback = "Voltaback raises \u20ac2.8M to scale its EV charging reimbursement platform across Europe.";
    const basalt = "Basalt Health raised $20 million Series A funding led by NEA.";
    const markdown = `${voltaback}\n\n${basalt}`;
    expect(
      label(
        [
          reading({ company: "Voltaback", label: "Series A", evidence: voltaback, stageQuote: basalt }),
          reading({ company: "Basalt Health", label: "Series A", evidence: basalt, stageQuote: basalt }),
        ],
        markdown,
      ),
    ).toEqual(["funding round", "Series A"]);
  });

  test("a single story's stage sentence stands without naming the company", () => {
    const evidence = "ZuriQ today announced it has raised $4.2M to commercialize a radical new architecture.";
    const stageQuote = "The seed funding round was led by Founderful with participation from SquareOne.";
    const markdown = `${evidence} ${stageQuote}`;
    expect(label([reading({ company: "ZuriQ", label: "Seed", evidence, stageQuote })], markdown)).toEqual(["Seed"]);
  });
});
