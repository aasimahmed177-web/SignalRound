import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { listRounds, persistRecords } from "../lib/persist";
import { describeInvestorPrune, type InvestorLink, notedRejections, pruneUnsupportedInvestors } from "../lib/prune-investors";
import { record, testDb } from "./helpers";

// The notes below are production's own (2026-09-23), copied from the rows they rejected investors on.
const UV_NOTE =
  "Sources agree on the $85 million Series E announced on September 23, 2026, led by Yali Capital and TDK Ventures, with Lip-Bu Tan investing. The sources mention existing or current investors and separately list Ultraviolette’s investors, but do not identify Lingotto, Qualcomm Ventures, Zoho Corporation, TVS Motors, or Speciale Invest as investors in this specific round.";
const BACKERS = ["Lingotto", "Qualcomm Ventures", "Zoho Corporation", "TVS Motors", "Speciale Invest"];

const link = (name: string, role: InvestorLink["role"] = "participant"): InvestorLink => ({
  investorId: name.toLowerCase(),
  name,
  role,
});

function verdictOn(notes: string[], links: InvestorLink[]): Record<string, string> {
  return Object.fromEntries(notedRejections(notes, links).map((r) => [r.name, r.action]));
}

describe("notedRejections", () => {
  test("Ultraviolette: the five backers the verdict says are not in this round come off; the syndicate stays", () => {
    const links = [link("Yali Capital", "lead"), link("TDK Ventures", "lead"), link("Lip-Bu Tan"), ...BACKERS.map((n) => link(n))];
    expect(verdictOn([UV_NOTE], links)).toEqual(Object.fromEntries(BACKERS.map((n) => [n, "remove"])));
  });

  test("the applier's structured lines name exactly: not investors, not supported, not leads (a lead only)", () => {
    const links = [link("Insight Partners", "lead"), link("Entrée Capital", "lead"), link("Plaid"), link("Acme"), link("Beta Fund")];
    expect(
      verdictOn(
        [
          "not leads: Insight Partners, Entrée Capital, Beta Fund",
          "not investors in this round: Plaid",
          "not supported for this round: Acme",
        ],
        links,
      ),
    ).toEqual({ "Insight Partners": "demote", "Entrée Capital": "demote", Plaid: "remove", Acme: "remove" });
    // A spelling on the line folds into the linked firm.
    expect(
      verdictOn(["not leads: Bain Capital, CPP Investments"], [link("Canada Pension Plan Investment Board (CPP Investments)", "lead")]),
    ).toEqual({
      "Canada Pension Plan Investment Board (CPP Investments)": "demote",
    });
  });

  test("the remark's shapes: a subject, an object, an elliptical clause, a back reference, a lead doubted", () => {
    expect(
      verdictOn(
        ["Sherpa Capital and InnoPinnacle Fund are not named as investors in this round by the supplied sources."],
        [link("Sherpa Capital"), link("InnoPinnacle Fund"), link("RA Capital Management", "lead")],
      ),
    ).toEqual({ "Sherpa Capital": "remove", "InnoPinnacle Fund": "remove" });
    expect(
      verdictOn(
        ["Sovereign AI venture fund is mentioned as a backer, but not explicitly as an investor in this round."],
        [link("Sovereign AI venture fund"), link("Plural")],
      ),
    ).toEqual({ "Sovereign AI venture fund": "remove" });
    expect(
      verdictOn(
        ["Platanus Ventures is described only as backing the company, not as participating in this round."],
        [link("Tether", "lead"), link("Platanus Ventures")],
      ),
    ).toEqual({ "Platanus Ventures": "remove" });
    expect(
      verdictOn(
        [
          "The sources name Coinbase Ventures, F-Prime, and North Island Ventures as participants, but do not support Archetype, Liquid2 Ventures, or Morgan Creek for this round.",
        ],
        [link("Coinbase Ventures"), link("F-Prime"), link("Archetype"), link("Morgan Creek")],
      ),
    ).toEqual({ Archetype: "remove", "Morgan Creek": "remove" });
    expect(
      verdictOn(
        [
          "The sources mention researchers and executives from Anthropic, OpenAI, and Thinking Machines, but do not state that those firms invested.",
        ],
        [link("OpenAI", "lead"), link("CRV", "lead"), link("Anthropic")],
      ),
    ).toEqual({ OpenAI: "remove", Anthropic: "remove" });
    // A manager named beside its fund: the manager goes, the fund it manages stays.
    expect(
      verdictOn(
        ["EQT is named as the manager of the Scaleup Europe Fund, not as a separate investor."],
        [link("EQT"), link("Scaleup Europe Fund", "lead")],
      ),
    ).toEqual({ EQT: "remove" });
    // "describe X as existing investors ..., not as participants": the object goes, the lead named before it stays.
    expect(
      verdictOn(
        [
          "The company release and PR Newswire identify Summit Partners as the lead and describe Insight Partners and Sixth Street Growth as existing investors maintaining significant ownership, not as participants in this round.",
        ],
        [link("Summit Partners", "lead"), link("Insight Partners"), link("Sixth Street Growth")],
      ),
    ).toEqual({ "Insight Partners": "remove", "Sixth Street Growth": "remove" });
    expect(
      verdictOn(
        [
          "Coller Capital and HSBC Asset Management are identified as lead and co-lead investors in the continuation vehicle, not explicitly as leads of the Series B.",
        ],
        [link("Coller Capital", "lead"), link("HSBC Asset Management")],
      ),
    ).toEqual({ "Coller Capital": "demote" });
  });

  test("a remark about a spelling, a figure, or who led elsewhere is not an investor verdict", () => {
    const none = (note: string, links: InvestorLink[], extra: string[] = []) => expect(verdictOn([...extra, note], links)).toEqual({});
    // Venus Aerospace: the verdict made "Mercury Fund" the lead; the remark doubts only the record's spelling.
    none(
      "The supplied record's July 10 date and investor label “Mercury” are not supported; the sources state “July 8, 2026” and “Mercury Fund.”",
      [link("Mercury", "lead")],
      ["leads: Mercury Fund (prnewswire.com)"],
    );
    none("The sources name the second lead as Ace Capital Partners, not Ace Ventures;", [link("ACE Ventures", "lead")]);
    none("The source names Scale AI, not Scale Venture Partners;", [link("Scale Venture Partners")]);
    none(
      "The company’s release identifies defy.vc as the lead of a separate pre-seed and AlleyCorp as the lead of the $6.5 million Seed round, so defy.vc is excluded from this round.",
      [link("AlleyCorp", "lead")],
    );
    none(
      "The sources state a $25 million investment by the British Business Bank as part of the Series C, but do not state that $25 million is the total amount raised in the round, so the round amount is left unstated.",
      [link("British Business Bank")],
    );
    none(
      "The company's release states a $6 million seed funding round and names Reforge, Fortwest Capital, Enlight Capital, NextGen Digital Venture, SNZ Capital, and Vernal as participants, but does not identify leads.",
      [link("Reforge", "lead"), link("Enlight Capital", "lead")],
    );
    none(
      "The release calls the investors 'anchored by' rather than 'led by,' but SaasRise explicitly describes AVP as the lead investors;",
      [link("AVP", "lead")],
    );
  });
});

describe("pruneUnsupportedInvestors", () => {
  async function seed() {
    const db = await testDb();
    // Written as the old paths left them: a verified row whose lists still hold what its verdict rejects.
    await persistRecords(
      db,
      [
        record({
          company_name: "Ultraviolette",
          company_key: "ultraviolette",
          stage: "series_d_plus",
          stage_as_written: "Series E",
          announced_date: "2026-09-23",
          amount: { value: 85, currency: "USD", as_written: "$85 million", usd_millions: 85, fx_rate: 1, fx_date: "2026-09-23" },
          lead_investors: ["Yali Capital", "TDK Ventures"],
          other_investors: ["Lip-Bu Tan", ...BACKERS],
          evidence_quotes: ["Ultraviolette has raised $85 million in a funding round led by Yali Capital and TDK Ventures."],
          sources: [
            {
              url: "https://yourstory.com/2026/09/ultraviolette-raises-85-million-series-e",
              host: "yourstory.com",
              title: "Ultraviolette raises $85 million in Series E",
            },
            { url: "https://entrackr.com/news/ultraviolette-raises-85-mn", host: "entrackr.com", title: "Ultraviolette raises $85 Mn" },
          ],
          confidence: 0.86,
          verification: { status: "confirmed", notes: [UV_NOTE], url: null, verifier: "gateway:openai/gpt-6-luna", sources_seen: 2 },
        }),
        record({
          company_name: "Easy Aerial",
          lead_investors: ["Insight Partners", "Entrée Capital"],
          other_investors: [],
          sources: [
            { url: "https://a.example/easy-aerial", host: "a.example", title: "Easy Aerial raises $20M" },
            { url: "https://b.example/easy-aerial", host: "b.example", title: "Easy Aerial closes Series B" },
          ],
          confidence: 0.9,
          verification: { status: "corrected", notes: ["not leads: Insight Partners, Entrée Capital"], url: null },
        }),
        record({
          company_name: "Kastle",
          lead_investors: ["Insight Partners"],
          sources: [
            {
              url: "https://www.prnewswire.com/news-releases/kastle-raises-24m-series-a-led-by-insight-partners-302881290.html",
              host: "prnewswire.com",
              title: "Kastle Raises $24M Series A Led by Insight Partners",
            },
          ],
          verification: {
            status: "confirmed",
            notes: [
              "Although the linked press-release URL contains “led-by-insight-partners,” the supplied article text does not explicitly state that Insight Partners led this round, so it is not included as a lead investor.",
            ],
            url: null,
          },
        }),
        record({ company_name: "Clean Co", lead_investors: ["Fund One"], other_investors: ["Angel Co"] }),
      ],
      "growth",
      "run-1",
    );
    // Easy Aerial is written with the leads its own notes demote: the state the old persist left behind.
    return db;
  }

  async function snapshot(db: Awaited<ReturnType<typeof testDb>>): Promise<string> {
    const out: unknown[] = [];
    for (const t of ["funding_rounds", "round_investors", "investors"])
      out.push((await db.execute(sql.raw(`select * from ${t} order by 1, 2`))).rows);
    return JSON.stringify(out);
  }

  test("the dry run prints each round, the links it would remove, the leads it would clear, and the evidence, and writes nothing", async () => {
    const db = await seed();
    const before = await snapshot(db);
    const summary = await pruneUnsupportedInvestors(db);
    expect(await snapshot(db)).toBe(before);
    expect(summary.applied).toBe(false);
    expect(summary.prunes.map((p) => p.company).sort()).toEqual(["Easy Aerial", "Ultraviolette"]);
    expect(summary.removed).toEqual({ lead: 0, participant: 5 });
    expect(summary.demoted).toBe(2);
    // Kastle's remark doubts a lead its own press-release headline states: printed, left alone.
    expect(summary.held.map((p) => p.company)).toEqual(["Kastle"]);
    const uv = summary.prunes.find((p) => p.company === "Ultraviolette");
    if (!uv) throw new Error("missing");
    const text = describeInvestorPrune(uv).join("\n");
    expect(text).toContain("remove participant Lingotto");
    expect(text).toContain("do not identify Lingotto");
    expect(text).toContain("source: Ultraviolette raises $85 Mn <https://entrackr.com/news/ultraviolette-raises-85-mn>");
    const easy = summary.prunes.find((p) => p.company === "Easy Aerial");
    if (!easy) throw new Error("missing");
    expect(describeInvestorPrune(easy).join("\n")).toContain("clear lead Insight Partners (stays a participant)");
    for (const p of [...summary.prunes, ...summary.held])
      for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)])
        expect(describeInvestorPrune(p).join("\n")).not.toContain(dash);
  });

  test("apply removes the links, clears the leads, notes what changed, rescores, and a second run finds nothing", async () => {
    const db = await seed();
    const applied = await pruneUnsupportedInvestors(db, { apply: true });
    expect(applied.prunes).toHaveLength(2);
    const rows = (await listRounds(db, { includeReview: true })).rows;
    const uv = rows.find((r) => r.company.name === "Ultraviolette");
    expect(uv?.lead_investors.sort()).toEqual(["TDK Ventures", "Yali Capital"]);
    expect(uv?.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(uv?.verification?.status).toBe("corrected");
    expect(uv?.verification?.notes[0]).toBe(`not supported for this round: ${BACKERS.join(", ")}`);
    expect(uv?.verification?.notes).toContain(UV_NOTE);
    // The leads stand, so the score and the disposition do too.
    expect(uv?.confidence).toBe(0.86);
    expect(uv?.disposition).toBe("publish");
    const easy = rows.find((r) => r.company.name === "Easy Aerial");
    expect(easy?.lead_investors).toEqual([]);
    expect(easy?.other_investors.sort()).toEqual(["Entrée Capital", "Insight Partners"]);
    // Its structured line already says so: not written twice.
    expect(easy?.verification?.notes).toContain("not leads: Insight Partners, Entrée Capital");
    // No lead left lowers the score by the lead's share alone.
    expect(easy?.confidence).toBeLessThan(0.9);
    expect(rows.find((r) => r.company.name === "Kastle")?.lead_investors).toEqual(["Insight Partners"]);
    expect(rows.find((r) => r.company.name === "Clean Co")?.other_investors).toEqual(["Angel Co"]);

    const before = await snapshot(db);
    const again = await pruneUnsupportedInvestors(db, { apply: true });
    expect(again.prunes).toEqual([]);
    expect(await snapshot(db)).toBe(before);
  });
});
