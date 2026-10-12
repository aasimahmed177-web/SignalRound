import { describe, expect, test } from "vitest";
import {
  cleanInvestors,
  dedupeInvestorNames,
  firmOfPerson,
  hasLeadLanguage,
  investorKeyForMerge,
  investorMentions,
  isPlaceholderInvestor,
  levenshtein,
  MAX_UNATTRIBUTED_LEADS,
  normalizeInvestorName,
} from "./investors.ts";
import { normalizeCompanyKey } from "./keys.ts";

/** Shorthand: leads, others, evidence, amount. */
function clean(leads: string[], others: string[], evidence: string, amount: string | null = null) {
  return cleanInvestors({ lead_investors: leads, other_investors: others, evidence, amount_as_written: amount });
}

describe("rule 1: leads need lead language", () => {
  test("mvrix: six names after 'joined by' are zero leads", () => {
    const names = [
      "Korea Investment Partners",
      "Intervest",
      "iGene",
      "Korea Omega Investment",
      "Lifecore Partners",
      "Seoul Techno Holdings",
    ];
    const out = clean(
      names,
      [],
      "MVRIX raised 8 billion won ($6.1 million) in Series B funding. The round was joined by Korea Investment Partners, Intervest, iGene, Korea Omega Investment, Lifecore Partners, and Seoul Techno Holdings.",
      "8 billion won",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(names);
    expect(out.dropped).toEqual([]);
  });

  test("voya-energy: names after 'from' are participants and 'other investors' drops", () => {
    const out = clean(
      ["Energy Impact Partners", "Founders Fund", "MANTIS Venture Capital", "Overmatch"],
      ["other investors"],
      "Voya Energy raised $35m in Series A funding from Energy Impact Partners, Founders Fund, MANTIS Venture Capital, Overmatch, and other investors.",
      "$35m",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Energy Impact Partners", "Founders Fund", "MANTIS Venture Capital", "Overmatch"]);
    expect(out.dropped).toEqual(["other investors"]);
  });

  test("felix-pago: 'participated in by' is participation, not a lead", () => {
    const out = clean(
      ["Andreessen Horowitz (a16z)"],
      [],
      "Felix Pago raised $200 million in Series B financing, which includes $87 million in equity financing and $113 million in credit facility financing. The equity financing was participated in by Andreessen Horowitz (a16z), while the credit facility financing came from General Catalyst's Customer Value Fund.",
      "$200 million",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Andreessen Horowitz (a16z)"]);
  });

  test("backbone: the four after 'led by' lead, the two after 'strategic co-investors' participate", () => {
    const out = clean(
      ["Pitchdrive", "ProFounders", "Passion Capital", "100IN", "Agristo", "Darta"],
      [],
      "Backbone raised €4M (~$4.3M) in pre-seed funding, led by Pitchdrive, ProFounders, Passion Capital, 100IN and strategic co-investors Agristo and Darta.",
      "€4M",
    );
    expect(out.lead_investors).toEqual(["Pitchdrive", "ProFounders", "Passion Capital", "100IN"]);
    expect(out.other_investors).toEqual(["Agristo", "Darta"]);
  });

  test("thyme-care: the name before 'led the round' leads; names after 'with' and before 'joining' follow", () => {
    const out = clean(
      ["Morgan Health", "CVS Health Ventures", "Humana"],
      [],
      "Thyme Care raised $125 million in Series E funding. Morgan Health led the round, with CVS Health Ventures and Humana joining.",
      "$125 million",
    );
    expect(out.lead_investors).toEqual(["Morgan Health"]);
    expect(out.other_investors).toEqual(["CVS Health Ventures", "Humana"]);
  });

  test("easy-aerial and ace-studio: 'investors including' and 'backed the round' name no lead", () => {
    expect(
      clean(
        ["Insight Partners", "Entrée Capital"],
        [],
        "Easy Aerial raised a $20 million Series B round from investors including Insight Partners and Entrée Capital.",
      ).lead_investors,
    ).toEqual([]);
    const ace = clean(
      ["Creation Ventures (CCV)", "Shunwei Capital", "alphaist"],
      ["other strategic investors"],
      "Creation Ventures (CCV), Shunwei Capital, alphaist, and other strategic investors backed the round.",
    );
    expect(ace.lead_investors).toEqual([]);
    expect(ace.other_investors).toEqual(["Creation Ventures (CCV)", "Shunwei Capital", "alphaist"]);
  });

  test("aisel-health and sirdab: 'led by' and 'co-led by ... and existing investor' keep their leads", () => {
    const aisel = clean(
      ["Caesar Ventures"],
      ["Nordic Web Ventures", "LifeX", "Angel Invest", "Rockstart", "EIFO"],
      "Aisel Health raised €1.7 million in pre-seed funding led by Caesar Ventures, with participation from Nordic Web Ventures, LifeX, Angel Invest, and returning investors Rockstart and EIFO.",
    );
    expect(aisel.lead_investors).toEqual(["Caesar Ventures"]);
    expect(aisel.other_investors).toEqual(["Nordic Web Ventures", "LifeX", "Angel Invest", "Rockstart", "EIFO"]);
    const sirdab = clean(
      ["Elm", "BECO Capital"],
      [],
      "Sirdab raised $10 million (SAR 37.5 million) in Series A funding, co-led by PIF-backed digital solutions company Elm and existing investor BECO Capital.",
    );
    expect(sirdab.lead_investors).toEqual(["Elm", "BECO Capital"]);
  });

  test("a participant the extractor called a lead is demoted even when someone else led", () => {
    const out = clean(
      ["Sequoia Capital", "Index Ventures"],
      [],
      "Acme raised $20M in Series A funding led by Sequoia Capital, with participation from Index Ventures.",
    );
    expect(out.lead_investors).toEqual(["Sequoia Capital"]);
    expect(out.other_investors).toEqual(["Index Ventures"]);
  });

  test("lead language present but names not in the evidence: at most three extractor leads survive", () => {
    const out = clean(
      ["Alpha Fund", "Beta Ventures", "Gamma Capital", "Delta Partners", "Epsilon"],
      [],
      "Acme raised $50M in a Series C round led by its existing backers.",
    );
    expect(out.lead_investors).toEqual(["Alpha Fund", "Beta Ventures", "Gamma Capital"]);
    expect(out.lead_investors).toHaveLength(MAX_UNATTRIBUTED_LEADS);
    expect(out.other_investors).toEqual(["Delta Partners", "Epsilon"]);
  });

  test("evidence silent on investors: the extractor's roles stand, capped at three leads", () => {
    const out = clean(
      ["Alpha Fund", "Beta Ventures", "Gamma Capital", "Delta Partners"],
      ["Omega"],
      "Acme raised $50M in Series C funding.",
    );
    expect(out.lead_investors).toEqual(["Alpha Fund", "Beta Ventures", "Gamma Capital"]);
    expect(out.other_investors).toEqual(["Delta Partners", "Omega"]);
  });

  test("polaris: 'backed by' names a participant, and an adjective is not lead language", () => {
    const out = clean(
      ["Ethereum Foundation"],
      [],
      "Polaris, a leading Ethereum project, raised a $1M angel round backed by Ethereum Foundation.",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Ethereum Foundation"]);
    expect(hasLeadLanguage("a leading AI startup raised $5M")).toBe(false);
    expect(hasLeadLanguage("Sequoia leads the $5M round")).toBe(true);
    expect(hasLeadLanguage("the round was co-led by A and B")).toBe(true);
  });

  test("sunshiki: the fund led, the manager after 'managed by' is not an investor", () => {
    const evidence =
      "The round was led by Circular Economy & Nature Positive Fund I, managed by SBI New Business Investment Co., Ltd., with participation from Ando-Hazama.";
    const glued = clean(
      ["Circular Economy & Nature Positive Fund I, managed by SBI New Business Investment Co., Ltd."],
      ["SBI New Business Investment Co., Ltd.", "Ando-Hazama"],
      evidence,
    );
    expect(glued.lead_investors).toEqual(["Circular Economy & Nature Positive Fund I"]);
    expect(glued.other_investors).toEqual(["Ando-Hazama"]);
    expect(glued.dropped).toEqual(["SBI New Business Investment Co., Ltd."]);
    // The extractor filed the fund as a participant: the "led by" in the evidence promotes it.
    const demoted = clean([], ["Circular Economy & Nature Positive Fund I", "Ando-Hazama"], evidence);
    expect(demoted.lead_investors).toEqual(["Circular Economy & Nature Positive Fund I"]);
    expect(demoted.other_investors).toEqual(["Ando-Hazama"]);
  });

  test("pwin: 'Blue Delta was a leader in' the round makes Blue Delta the lead", () => {
    const out = clean(
      [],
      ["Blue Delta"],
      "Blue Delta was a leader in pWin.ai's $10 million seed funding round, which the Tysons startup announced closed in June 2025.",
      "$10 million",
    );
    expect(out.lead_investors).toEqual(["Blue Delta"]);
    expect(out.other_investors).toEqual([]);
    expect(hasLeadLanguage("Blue Delta was a leader in pWin.ai's seed funding round")).toBe(true);
    // The market sense of the noun is not lead language.
    expect(hasLeadLanguage("Acme is a leader in enterprise AI and raised $5M from Sequoia.")).toBe(false);
  });

  test("'led the round' and 'is leading' name the lead in front of them", () => {
    const led = clean([], ["S3 Ventures", "Accel"], "S3 Ventures led the round, with Accel participating.");
    expect(led.lead_investors).toEqual(["S3 Ventures"]);
    expect(led.other_investors).toEqual(["Accel"]);
    const leading = clean([], ["Sequoia Capital"], "Sequoia Capital is leading the $25 million round.");
    expect(leading.lead_investors).toEqual(["Sequoia Capital"]);
  });

  test("renofi: 'led by Fifth Wall and participation from Progressive Insurance' has one lead", () => {
    const out = clean(
      ["Fifth Wall", "Progressive Insurance"],
      [],
      "RenoFi announced Tuesday that it closed a $30 million Series B led by Fifth Wall and participation from Progressive Insurance.",
      "$30 million",
    );
    expect(out.lead_investors).toEqual(["Fifth Wall"]);
    expect(out.other_investors).toEqual(["Progressive Insurance"]);
  });

  test("elucid: 'other new and existing investors include' names participants; an appositive parent drops", () => {
    const out = clean(
      ["IAG Capital Partners", "Elevage Medical Technologies", "Patient Square Capital"],
      [],
      "Other new and existing investors include IAG Capital Partners and Elevage Medical Technologies, a platform created by Patient Square Capital.",
      "$55M",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["IAG Capital Partners", "Elevage Medical Technologies"]);
    expect(out.dropped).toEqual(["Patient Square Capital"]);
    // The extractor may hand the appositive over as part of the name.
    const glued = clean(
      [],
      ["Elevage Medical Technologies, a platform created by Patient Square Capital"],
      "Elucid raised $55M in Series D funding.",
    );
    expect(glued.other_investors).toEqual(["Elevage Medical Technologies"]);
  });

  test("airway-therapeutics: 'participants included' names no lead; a syndicate of family offices drops", () => {
    const out = clean(
      ["Cincinnati Children's"],
      ["a syndicate of large family offices"],
      "Participants included Cincinnati Children's and a syndicate of large family offices.",
      "$50 million",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Cincinnati Children's"]);
    expect(out.dropped).toEqual(["a syndicate of large family offices"]);
  });

  test("ausperbio: 'led by a strategic investor and included new investment from' leaves a participant", () => {
    const out = clean(
      ["RA Capital Management, L.P."],
      ["HanKang Capital"],
      "The financing was led by a strategic investor and included new investment from RA Capital Management, L.P., alongside continued backing from existing investors HanKang Capital.",
      "$120M",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["RA Capital Management", "HanKang Capital"]);
  });

  test("fintax: 'led by X via Y, with A, B, C and others participating' has one lead and one HashHouse", () => {
    const out = clean(
      ["YZi Labs (ex Binance Labs)", "Amber Group", "Hash House"],
      ["HashHouse Tech", "Pundi AI", "BGIN", "Bgin Blockchain", "others"],
      "FinTax announced the completion of its Seed funding round, led by YZi Labs via EASYResidency S4, with Amber Group, HashHouse Tech, Pundi AI and others participating.",
      null,
    );
    expect(out.lead_investors).toEqual(["YZi Labs"]);
    expect(out.other_investors).toEqual(["Amber Group", "HashHouse Tech", "Pundi AI", "Bgin Blockchain"]);
    expect(out.dropped).toEqual(["others", "Hash House", "BGIN"]);
    // The vehicle after "via" is not an investor.
    const vehicle = clean(["YZi Labs", "EASYResidency S4"], [], "The round was led by YZi Labs via EASYResidency S4.");
    expect(vehicle.lead_investors).toEqual(["YZi Labs"]);
    expect(vehicle.dropped).toEqual(["EASYResidency S4"]);
  });

  test("glow: a lead the sentence never names is not promoted; precision over recall", () => {
    const out = cleanInvestors({
      lead_investors: ["Lux Capital"],
      other_investors: ["Foundation Capital", "SciFi VC"],
      evidence: "Glow raised $30 million in Series A funding, with participation from Foundation Capital and SciFi VC.",
      amount_as_written: "$30 million",
    });
    // The lead sentence lives elsewhere on the page; the extractor's word alone does not make a lead.
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Lux Capital", "Foundation Capital", "SciFi VC"]);
    // A sentence that never speaks of investors leaves the extractor's leads standing, capped.
    const silent = cleanInvestors({
      lead_investors: ["Lux Capital"],
      other_investors: [],
      evidence: "Glow raised $30 million in Series A funding.",
      amount_as_written: "$30 million",
    });
    expect(silent.lead_investors).toEqual(["Lux Capital"]);
  });
});

describe("rule 2: placeholders are not investors", () => {
  test("rwaj, lyte, elucid: generic entries drop", () => {
    expect(clean([], ["undisclosed investors"], "Rwaj has raised USD 1.2 million in pre-seed funding.").other_investors).toEqual([]);
    const lyte = clean(
      ["Maverick Silicon"],
      ["Fidelity", "additional existing and new investors"],
      "Lyte raised $165M in Series C funding led by Maverick Silicon, with participation from Fidelity and additional existing and new investors.",
    );
    expect(lyte.other_investors).toEqual(["Fidelity"]);
    expect(lyte.dropped).toEqual(["additional existing and new investors"]);
    const elucid = clean(
      ["Unnamed publicly traded medical-device company", "Unnamed medical device strategic partner"],
      ["Large medtech company"],
      "Elucid raised $55M in Series D funding.",
    );
    expect(elucid.lead_investors).toEqual([]);
    expect(elucid.other_investors).toEqual([]);
    expect(elucid.dropped).toHaveLength(3);
  });

  test("the placeholder vocabulary, entry by entry", () => {
    for (const p of [
      "undisclosed investors",
      "existing investors",
      "new investors",
      "additional strategic investors",
      "strategic angels",
      "angel investors",
      "a consortium of investors",
      "a group of family offices",
      "family offices",
      "other investors",
      "others",
      "30+ founders",
      "several institutional investors",
    ]) {
      expect(isPlaceholderInvestor(p), p).toBe(true);
    }
    for (const real of [
      "Founders Fund",
      "Angel Invest",
      "New Enterprise Associates",
      "Institutional Venture Partners",
      "Top Tier Capital Partners",
      "Sequoia Capital",
      "Erebor Bank",
    ]) {
      expect(isPlaceholderInvestor(real), real).toBe(false);
    }
  });

  test("guardio: a sentence drops entirely when what follows 'including' is a person named by a role", () => {
    const out = clean(
      ["Existing investors, founders, and strategic angels, including Wiz co-founder Assaf Rappaport"],
      [],
      "Guardio raised $40 million in a growth round from existing investors, founders, and strategic angels, including Wiz co-founder Assaf Rappaport.",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toHaveLength(1);
  });

  test("a firm embedded after 'including' survives as a participant", () => {
    const out = clean(
      ["Existing investors, including Sequoia Capital"],
      [],
      "Acme raised $5M from existing investors, including Sequoia Capital.",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Sequoia Capital"]);
  });

  test("primero: a descriptive phrase split on commas drops with the names it listed", () => {
    const out = clean(
      ["Kaszek"],
      ["angel investors connected to FEMSA", "Bimbo", "Aeroméxico"],
      "Primero raised $12M in seed funding led by Kaszek, with participation from angel investors connected to FEMSA, Bimbo, and Aeroméxico.",
    );
    expect(out.lead_investors).toEqual(["Kaszek"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["angel investors connected to FEMSA", "Bimbo", "Aeroméxico"]);
  });

  test("an entry over 80 characters is a description, not a name", () => {
    const long = "A syndicate that brought together the leading family offices of the region and a number of unnamed strategic partners";
    expect(clean([], [long], "Acme raised $5M.").dropped).toEqual([long]);
  });

  test("'existing investor X' is X", () => {
    const out = clean(
      ["Sequoia Capital"],
      ["existing investor BECO Capital"],
      "Acme raised $5M led by Sequoia Capital, with participation from existing investor BECO Capital.",
    );
    expect(out.other_investors).toEqual(["BECO Capital"]);
  });

  test("mundo: 'N1 in Prague' is a fragment, not a firm", () => {
    expect(isPlaceholderInvestor("N1 in Prague")).toBe(true);
    expect(isPlaceholderInvestor("Partners in Equity")).toBe(false);
    const out = clean(
      ["Inovia Capital"],
      ["N1 in Prague"],
      "Mundo raised $20 million USD ($28 million CAD) in Series A funding led by Inovia Capital.",
    );
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["N1 in Prague"]);
  });

  test("counted crowds are placeholders", () => {
    for (const p of ["more than a dozen others", "over 20 angels", "a dozen angel investors", "nearly 50 individual investors"]) {
      expect(isPlaceholderInvestor(p), p).toBe(true);
    }
  });

  test("a leading article does not rescue a placeholder", () => {
    expect(isPlaceholderInvestor("an unidentified large medical technology company")).toBe(true);
  });

  test("an entry that opens with a preposition is a clause fragment, never a name", () => {
    for (const p of [
      "from the payments, fintech and enterprise technology sectors",
      "in the software ecosystem",
      "of existing investors",
      // A firm word after the preposition does not rescue the fragment.
      "from Acme Capital",
    ]) {
      expect(isPlaceholderInvestor(p), p).toBe(true);
    }
  });

  test("a generic crowd, and a crowd 'of' a firm, names nobody", () => {
    for (const p of [
      "private U.S. investors",
      "startup founders and operators",
      "institutional clients of Hg",
      "founders of Ramp",
      "executives of Google",
      "the founders of Circle",
    ]) {
      expect(isPlaceholderInvestor(p), p).toBe(true);
    }
    // A firm word before "of" keeps the name.
    expect(isPlaceholderInvestor("Partners of Acme")).toBe(false);
    expect(isPlaceholderInvestor("Bank of America")).toBe(false);
    expect(isPlaceholderInvestor("University of Michigan")).toBe(false);
  });
});

describe("rule 3: a person of a firm is the firm", () => {
  test("peppy: 'Colin Gardiner of Yonder' is Yonder and merges with Yonder", () => {
    const out = clean(
      ["Element Ventures"],
      ["Rock Creek Capital, LLC", "Mana Ventures", "Colin Gardiner of Yonder", "Yonder"],
      "The round was led by Element Ventures, with strategic participation from Rock Creek Capital, LLC, Mana Ventures, and Colin Gardiner of Yonder.",
    );
    expect(out.lead_investors).toEqual(["Element Ventures"]);
    expect(out.other_investors).toEqual(["Rock Creek Capital", "Mana Ventures", "Yonder"]);
    expect(out.dropped).toEqual(["Colin Gardiner of Yonder"]);
  });

  test("owner: a team at a firm is the firm", () => {
    expect(firmOfPerson("Growth Equity at Goldman Sachs Alternatives")).toBe("Goldman Sachs Alternatives");
    const out = clean(
      ["Growth Equity at Goldman Sachs Alternatives", "Goldman Sachs Alternatives"],
      [],
      "Owner raised a Series D led by Growth Equity at Goldman Sachs Alternatives.",
    );
    expect(out.lead_investors).toEqual(["Goldman Sachs Alternatives"]);
    expect(out.other_investors).toEqual([]);
  });

  test("'of' inside a firm's own name is left alone", () => {
    expect(firmOfPerson("Bank of America")).toBeNull();
    expect(firmOfPerson("University of Michigan")).toBeNull();
    expect(firmOfPerson("Colin Gardiner of Yonder")).toBe("Yonder");
    expect(firmOfPerson("the crypto arm of Andreessen Horowitz")).toBe("Andreessen Horowitz");
    expect(firmOfPerson("Assaf Rappaport, co-founder of Wiz")).toBeNull();
  });

  test("a person named by a role elsewhere is dropped unless the page lists them plainly", () => {
    const roleOnly = clean(
      ["Sequoia Capital"],
      ["Assaf Rappaport (Wiz co-founder)"],
      "Acme raised $10M led by Sequoia Capital, with strategic angels including Wiz co-founder Assaf Rappaport.",
    );
    expect(roleOnly.other_investors).toEqual([]);
    expect(roleOnly.dropped).toEqual(["Assaf Rappaport (Wiz co-founder)"]);
    const named = clean(
      ["Sequoia Capital"],
      ["Assaf Rappaport (Wiz co-founder)"],
      "Acme raised $10M led by Sequoia Capital, with participation from Assaf Rappaport and Naval Ravikant.",
    );
    expect(named.other_investors).toEqual(["Assaf Rappaport"]);
  });

  test("an angel named as an investor stays, and 'Founders Fund' is not a founder", () => {
    const out = clean(
      ["Khosla Ventures"],
      ["Naval Ravikant", "Founders Fund"],
      "Acme raised $7.5M led by Khosla Ventures, with participation from Naval Ravikant and Founders Fund.",
    );
    expect(out.other_investors).toEqual(["Naval Ravikant", "Founders Fund"]);
  });

  test("a person 'formerly of' a firm is the person, investing as themselves", () => {
    const out = clean(
      ["Acme Ventures"],
      ["Jack Corddry, formerly of Frax Finance", "Jane Doe, previously of Sequoia"],
      "Acme raised $5M led by Acme Ventures, with participation from Jack Corddry, formerly of Frax Finance, and Jane Doe, previously of Sequoia.",
    );
    expect(out.other_investors).toEqual(["Jack Corddry", "Jane Doe"]);
  });

  test("an owner-wrapped fund named alone is the wrapped fund", () => {
    const m12 = clean([], ["Microsoft Corp.'s M12 fund"], "Acme raised $5M with participation from Microsoft Corp.'s M12 fund.");
    expect(m12.other_investors).toEqual(["M12"]);
    const oxford = clean(
      [],
      ["University of Oxford's Oxford Seed Fund"],
      "Acme raised $5M with participation from University of Oxford's Oxford Seed Fund.",
    );
    expect(oxford.other_investors).toEqual(["Oxford Seed Fund"]);
    const temasek = clean(
      [],
      ["Temasek Trust's Catalytic Capital for Climate and Health fund"],
      "Acme raised $5M with participation from Temasek Trust's Catalytic Capital for Climate and Health fund.",
    );
    expect(temasek.other_investors).toEqual(["Catalytic Capital for Climate and Health"]);
  });

  test("a wrapped fund with no capitalised name inside is the owner", () => {
    const scout = clean([], ["General Catalyst's scout fund"], "Acme raised $5M with participation from General Catalyst's scout fund.");
    expect(scout.other_investors).toEqual(["General Catalyst"]);
    const seed = clean([], ["Sequoia's seed fund"], "Acme raised $5M with participation from Sequoia's seed fund.");
    expect(seed.other_investors).toEqual(["Sequoia"]);
  });

  test("a strategy at a firm and a fund named by its manager are the firm", () => {
    expect(firmOfPerson("Growth Equity at Goldman Sachs Alternatives")).toBe("Goldman Sachs Alternatives");
    const managed = clean(
      [],
      ["funds managed by Kayne Anderson Rudnick Investment Management"],
      "Acme raised $5M with participation from funds managed by Kayne Anderson Rudnick Investment Management.",
    );
    expect(managed.other_investors).toEqual(["Kayne Anderson Rudnick Investment Management"]);
  });
});

describe("rule 4: one firm, one entry", () => {
  test("hivebotics: a region suffix is the same firm, the longer form kept, listed once as a lead", () => {
    const out = clean(
      ["Vertex Ventures Southeast Asia & India", "Vertex Ventures"],
      ["Fareast Land Development", "Rigel"],
      "Hivebotics raised a Series A led by Vertex Ventures Southeast Asia & India, with Fareast Land Development and Rigel participating.",
    );
    expect(out.lead_investors).toEqual(["Vertex Ventures Southeast Asia & India"]);
    expect(out.other_investors).toEqual(["Fareast Land Development", "Rigel"]);
    expect(out.dropped).toEqual(["Vertex Ventures"]);
  });

  test("openreserve: a16z crypto and Andreessen Horowitz (a16z) are one firm, the written-out form kept", () => {
    const out = clean(
      ["a16z crypto", "Andreessen Horowitz (a16z)"],
      [],
      "Andreessen Horowitz's crypto arm said on September 3 that it is leading a $25 million seed round in OpenReserve.",
    );
    expect(out.lead_investors).toEqual(["Andreessen Horowitz (a16z)"]);
    expect(out.dropped).toEqual(["a16z crypto"]);
    expect(investorKeyForMerge("a16z crypto")).toBe("andreessen horowitz crypto");
    expect(investorKeyForMerge("Andreessen Horowitz (a16z)")).toBe("andreessen horowitz");
  });

  test("a firm's other whole name keys as the firm: YC is Y Combinator, Sequoia India is Sequoia Capital India", () => {
    expect(investorKeyForMerge("YC")).toBe(investorKeyForMerge("Y Combinator"));
    expect(investorKeyForMerge("Sequoia India")).toBe(investorKeyForMerge("Sequoia Capital India"));
    // Only the whole name: a fund that starts with the short form keeps its own key.
    expect(investorKeyForMerge("YC Continuity Fund")).not.toBe(investorKeyForMerge("Y Combinator"));
    expect(investorKeyForMerge("Sequoia India Seed Fund")).not.toBe(investorKeyForMerge("Sequoia Capital India"));
  });

  test("a misspelling a source printed keys as the firm: Sequioa Capital is Sequoia", () => {
    expect(investorKeyForMerge("Sequioa Capital")).toBe("sequoia");
    expect(investorKeyForMerge("Sequioa Capital India")).toBe(investorKeyForMerge("Sequoia Capital India"));
  });

  test("lyte: 'Key 1 Capital' and 'Key1 Capital' are one firm, Fidelity is listed once", () => {
    const out = clean(
      ["Maverick Silicon"],
      ["Fidelity", "Key 1 Capital", "Fidelity", "Key1 Capital"],
      "Lyte raised $165M in Series C funding led by Maverick Silicon, with participation from Fidelity and Key1 Capital.",
    );
    expect(out.other_investors).toEqual(["Fidelity", "Key1 Capital"]);
    expect(out.dropped).toEqual(["Fidelity", "Key 1 Capital"]);
  });

  test("catch: 'Factorial Funds' and 'Factorial Capital' keep the spelling in the evidence", () => {
    const out = clean(
      ["Hetz Ventures"],
      ["Factorial Funds", "Factorial Capital"],
      "Catch raised a seed round led by Hetz Ventures, with participation from Factorial Capital.",
    );
    expect(out.other_investors).toEqual(["Factorial Capital"]);
    const reversed = clean(
      ["Hetz Ventures"],
      ["Factorial Capital", "Factorial Funds"],
      "Catch raised a seed round led by Hetz Ventures, with participation from Factorial Funds.",
    );
    expect(reversed.other_investors).toEqual(["Factorial Funds"]);
  });

  test("ausperbio: a firm in both lists is a lead only", () => {
    const out = clean(
      ["RA Capital"],
      ["RA Capital", "Sanofi Ventures"],
      "AusperBio raised $120M in Series C funding led by RA Capital, with participation from Sanofi Ventures.",
    );
    expect(out.lead_investors).toEqual(["RA Capital"]);
    expect(out.other_investors).toEqual(["Sanofi Ventures"]);
  });

  test("a different region is not merged when the shorter form is not its prefix", () => {
    const out = clean(
      ["Sequoia Capital"],
      ["Sequoia Heritage"],
      "Acme raised $5M led by Sequoia Capital, with participation from Sequoia Heritage.",
    );
    expect(out.other_investors).toEqual(["Sequoia Heritage"]);
  });

  test("gimlet: an owner-wrapped fund and its dashed spelling are one firm; 'more than a dozen others' drops", () => {
    const out = clean(
      ["Sapphire Ventures"],
      ["M12 – Microsoft's Venture Fund", "Microsoft Corp.'s M12 fund", "more than a dozen others"],
      "Gimlet raised $20 million in Series B funding led by Sapphire Ventures, with participation from M12 – Microsoft's Venture Fund and more than a dozen others.",
      "$20 million",
    );
    expect(out.other_investors).toEqual(["M12 – Microsoft's Venture Fund"]);
    expect(out.dropped).toEqual(["more than a dozen others", "Microsoft Corp.'s M12 fund"]);
    expect(isPlaceholderInvestor("more than a dozen others")).toBe(true);
    expect(dedupeInvestorNames(["Microsoft Corp.'s M12 fund", "M12 – Microsoft's Venture Fund"])).toEqual([
      "M12 – Microsoft's Venture Fund",
    ]);
    // Microsoft itself is not M12: the owner is a prefix, not a wrapper.
    expect(dedupeInvestorNames(["Microsoft", "Microsoft Corp.'s M12 fund"])).toHaveLength(2);
  });

  test("thyme-care: 'a16z Bio + Health' folds into 'Andreessen Horowitz' through the alias table", () => {
    const out = clean(
      ["Morgan Health"],
      ["Andreessen Horowitz", "a16z Bio + Health", "CVS Health Ventures"],
      "Thyme Care raised $125 million in Series E funding led by Morgan Health, with participation from a16z Bio + Health and CVS Health Ventures.",
      "$125 million",
    );
    expect(out.other_investors).toEqual(["Andreessen Horowitz", "CVS Health Ventures"]);
    expect(out.dropped).toEqual(["a16z Bio + Health"]);
    expect(investorKeyForMerge("a16z Bio + Health")).toBe("andreessen horowitz bio health");
  });

  test("gatik: 'ARK Invest' and 'ARK Investment Management' are one firm by token prefix", () => {
    const out = clean(
      ["Isuzu"],
      ["ARK Invest", "ARK Investment Management"],
      "Gatik raised $100 million in Series C funding led by Isuzu, with participation from ARK Investment Management.",
      "$100 million",
    );
    expect(out.other_investors).toEqual(["ARK Investment Management"]);
    expect(out.dropped).toEqual(["ARK Invest"]);
    expect(dedupeInvestorNames(["ARK Invest", "ARK Investment Management"])).toEqual(["ARK Investment Management"]);
    // A short stem is not a prefix match: Ark is not Arkose Labs.
    expect(dedupeInvestorNames(["Ark", "Arkose Labs"])).toHaveLength(2);
    expect(dedupeInvestorNames(["Accel", "Accel-KKR"])).toHaveLength(2);
  });

  test("castelion: 'T. Rowe Price Associates' and 'T. Rowe Price' are one firm", () => {
    const out = clean(
      ["Lightspeed Venture Partners"],
      ["T. Rowe Price Associates", "T. Rowe Price"],
      "Castelion announced a $1 billion Series C fundraise on Wednesday led by Lightspeed Venture Partners, with participation from T. Rowe Price Associates.",
      "$1 billion",
    );
    expect(out.other_investors).toEqual(["T. Rowe Price Associates"]);
    expect(out.dropped).toEqual(["T. Rowe Price"]);
  });

  test("fintax: 'Hash House' is 'HashHouse Tech' and 'BGIN' is 'Bgin Blockchain'", () => {
    expect(dedupeInvestorNames(["Hash House", "HashHouse Tech"])).toEqual(["HashHouse Tech"]);
    expect(dedupeInvestorNames(["BGIN", "Bgin Blockchain"])).toEqual(["Bgin Blockchain"]);
  });

  test("zenergize: 'angel investor Sunil Kalra' is Sunil Kalra", () => {
    const out = clean(
      [],
      ["Sunil Kalra", "angel investor Sunil Kalra"],
      "Zenergize Technologies raised $4 million in Pre-Series A funding from angel investor Sunil Kalra and existing investors.",
      "$4 million",
    );
    expect(out.other_investors).toEqual(["Sunil Kalra"]);
    expect(out.dropped).toEqual(["angel investor Sunil Kalra"]);
    // A capitalized "Investor" opens a firm's name, not a role.
    const firm = clean([], ["Investor AB"], "Acme raised $5M from Investor AB.");
    expect(firm.other_investors).toEqual(["Investor AB"]);
  });

  test("distinct funds that share a word stay two", () => {
    const out = clean(
      ["Sequoia Capital", "Maverick Capital"],
      ["Sequoia Heritage", "Maverick Silicon"],
      "Acme raised $50M co-led by Sequoia Capital and Maverick Capital, with participation from Sequoia Heritage and Maverick Silicon.",
    );
    expect(out.lead_investors).toEqual(["Sequoia Capital", "Maverick Capital"]);
    expect(out.other_investors).toEqual(["Sequoia Heritage", "Maverick Silicon"]);
    expect(dedupeInvestorNames(["General Catalyst", "Catalyst Fund"])).toHaveLength(2);
  });

  test("a list assembled from several sources names each firm once, in the fullest form", () => {
    expect(
      dedupeInvestorNames(["GV", "Google Ventures", "Blackstone", "Blackstone Innovations Investments", "GSK", "GlaxoSmithKline"]),
    ).toEqual(["Google Ventures", "Blackstone Innovations Investments", "GlaxoSmithKline"]);
    expect(dedupeInvestorNames(["Curql", "Curql Collective", "Carlyle", "The Carlyle Group"])).toEqual([
      "Curql Collective",
      "The Carlyle Group",
    ]);
    expect(dedupeInvestorNames(["Key 1 Capital", "Key1 Capital"])).toEqual(["Key 1 Capital"]);
    expect(dedupeInvestorNames(["Arm", "Arm Holdings", "M12", "M12 – Microsoft's Venture Fund"])).toEqual([
      "Arm Holdings",
      "M12 – Microsoft's Venture Fund",
    ]);
    // Distinct firms with a shared word stay distinct.
    expect(dedupeInvestorNames(["Sequoia Capital", "Sequoia Heritage", "Maverick Capital", "Maverick Silicon"])).toHaveLength(4);
  });
});

describe("rule 5: lenders are not investors", () => {
  test("valar-atomics: the names in the credit facility clause drop, the equity lead stays", () => {
    const out = clean(
      ["Sequoia Capital"],
      ["Erebor Bank", "J.P. Morgan", "Crescent Cove", "Hercules Capital"],
      "Valar Atomics closed a $1 billion Series B led by Sequoia Capital, alongside a $200 million credit facility led by Erebor Bank and supported by J.P. Morgan, Crescent Cove and Hercules Capital.",
      "$1 billion",
    );
    expect(out.lead_investors).toEqual(["Sequoia Capital"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["Erebor Bank", "J.P. Morgan", "Crescent Cove", "Hercules Capital"]);
  });

  test("felix-pago: the facility's provider drops, the equity participant stays", () => {
    const out = clean(
      ["Andreessen Horowitz (a16z)"],
      ["General Catalyst's Customer Value Fund"],
      "The equity financing was participated in by Andreessen Horowitz (a16z), while the credit facility financing came from General Catalyst's Customer Value Fund.",
      "$200 million",
    );
    expect(out.other_investors).toEqual(["Andreessen Horowitz (a16z)"]);
    expect(out.dropped).toEqual(["General Catalyst's Customer Value Fund"]);
  });

  test("a debt round keeps its lenders: the round's own amount sits in the clause", () => {
    const out = clean(
      [],
      ["Silicon Valley Bank", "Hercules Capital"],
      "Acme secured a $30 million venture debt facility from Silicon Valley Bank and Hercules Capital.",
      "$30 million",
    );
    expect(out.other_investors).toEqual(["Silicon Valley Bank", "Hercules Capital"]);
  });

  test("a company that makes loans is not a debt clause", () => {
    const out = clean(
      ["Sequoia Capital"],
      [],
      "Acme, a fintech loan platform for small businesses, raised $10M in Series A funding led by Sequoia Capital.",
      "$10M",
    );
    expect(out.lead_investors).toEqual(["Sequoia Capital"]);
  });
});

describe("rule 6: typos are not new firms", () => {
  test("elucid: 'AG Capital Partners' is 'IAG Capital Partners' when the evidence spells it so", () => {
    const out = clean(
      ["Elephas Ventures"],
      ["AG Capital Partners", "IAG Capital Partners"],
      "Elucid raised $55M in Series D funding led by Elephas Ventures, with participation from IAG Capital Partners.",
    );
    expect(out.other_investors).toEqual(["IAG Capital Partners"]);
    expect(out.dropped).toEqual(["AG Capital Partners"]);
    expect(levenshtein("ag capital partners", "iag capital partners")).toBe(1);
  });

  test("backbone: '100Insp' is a truncation typo of '100IN', the evidence spelling kept as the lead", () => {
    const out = clean(["Pitchdrive", "100Insp"], ["100IN"], "Backbone raised €4M in pre-seed funding, led by Pitchdrive and 100IN.");
    expect(out.lead_investors).toEqual(["Pitchdrive", "100IN"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["100Insp"]);
  });

  test("two real firms one edit apart both in the evidence stay apart", () => {
    const out = clean([], ["Lakestar", "Lakestor"], "Acme raised $5M from Lakestar and Lakestor.");
    expect(out.other_investors).toEqual(["Lakestar", "Lakestor"]);
  });

  test("two firms one edit apart with neither in the evidence stay apart", () => {
    const out = clean([], ["Lakestar", "Lakestor"], "Acme raised $5M.");
    expect(out.other_investors).toEqual(["Lakestar", "Lakestor"]);
  });
});

describe("rule 7: affiliations are not investors", () => {
  test("norbert-health: the companies before 'founders' and 'co-founder' drop, the angels stay", () => {
    const out = clean(
      [],
      ["Datadog", "Alexis Le-Quoc", "Olivier Pomel", "Noom", "Saeju Jeong", "Owkin", "Thomas Clozel"],
      "The round included angel investors including Datadog founders Alexis Le-Quoc and Olivier Pomel, Noom co-founder Saeju Jeong, and Owkin co-founder Thomas Clozel.",
    );
    expect(out.lead_investors).toEqual([]);
    expect(out.other_investors).toEqual(["Alexis Le-Quoc", "Olivier Pomel", "Saeju Jeong", "Thomas Clozel"]);
    expect(out.dropped).toEqual(["Datadog", "Noom", "Owkin"]);
  });

  test("'co-founder of Wiz' drops Wiz; 'Colin Gardiner of Yonder' still stands for Yonder", () => {
    const role = clean(
      ["Sequoia Capital"],
      ["Wiz"],
      "Acme raised $10M led by Sequoia Capital, with participation from Assaf Rappaport, co-founder of Wiz.",
    );
    expect(role.other_investors).toEqual([]);
    expect(role.dropped).toEqual(["Wiz"]);
    const firm = clean([], ["Colin Gardiner of Yonder"], "The round included Colin Gardiner of Yonder.");
    expect(firm.other_investors).toEqual(["Yonder"]);
  });

  test("a firm word after a name is not a role: 'Founders Fund' stays", () => {
    const out = clean(
      ["Sequoia Capital"],
      ["Founders Fund"],
      "Acme raised $10M led by Sequoia Capital, with participation from Founders Fund.",
    );
    expect(out.other_investors).toEqual(["Founders Fund"]);
  });
});

describe("rule 8: prior backers and partners are not this round's investors", () => {
  test("clearjet: names after 'investor base also includes early backers' drop", () => {
    const out = clean(
      ["Edison Partners"],
      ["Sky VC", "Tandem Ventures"],
      "ClearJet raised $20 million in growth funding led by Edison Partners. ClearJet's investor base also includes early backers Sky VC and Tandem Ventures.",
      "$20 million",
    );
    expect(out.lead_investors).toEqual(["Edison Partners"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["Sky VC", "Tandem Ventures"]);
  });

  test("digs: firms the startup 'previously drew backing from' drop", () => {
    const out = clean(
      ["Sozo Ventures"],
      ["Fuse", "Flying Fish", "Oregon Venture Fund", "Cascade Seed Fund"],
      "Digs raised a $9 million Series A led by Sozo Ventures. The startup previously drew backing from regional venture firms including Fuse, Flying Fish, Oregon Venture Fund, and Cascade Seed Fund.",
      "$9 million",
    );
    expect(out.lead_investors).toEqual(["Sozo Ventures"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["Fuse", "Flying Fish", "Oregon Venture Fund", "Cascade Seed Fund"]);
  });

  test("rqd-clearing: an investment dated to a month before the round's own date is a prior round", () => {
    const out = clean(
      ["Bain Capital Tech Opportunities"],
      ["Gentree Fund"],
      "RQD Clearing closed a $74M minority growth investment on August 27, 2026, led by Bain Capital Tech Opportunities. The company received a strategic investment from Gentree Fund in May 2026.",
      "$74M",
    );
    expect(out.lead_investors).toEqual(["Bain Capital Tech Opportunities"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["Gentree Fund"]);
    // Both dates in one sentence: only the clause holding the earlier date is prior.
    const oneSentence = clean(
      ["Bain Capital Tech Opportunities"],
      ["Gentree Fund"],
      "RQD Clearing closed a $74M minority growth investment on August 27, 2026, led by Bain Capital Tech Opportunities, following a strategic investment from Gentree Fund in May 2026.",
      "$74M",
    );
    expect(oneSentence.lead_investors).toEqual(["Bain Capital Tech Opportunities"]);
    expect(oneSentence.dropped).toEqual(["Gentree Fund"]);
    // One date alone dates the round, not a prior one.
    const single = clean([], ["Gentree Fund"], "RQD Clearing received a strategic investment from Gentree Fund in May 2026.");
    expect(single.other_investors).toEqual(["Gentree Fund"]);
  });

  test("huskeys: names after 'partners include' are partners", () => {
    const out = clean(
      ["Blackstone Innovations Investments"],
      ["Cloudflare", "Check Point", "AWS", "Google", "Microsoft", "Intel"],
      "Huskeys raised $12 million in Series A funding led by Blackstone Innovations Investments. Its partners include Cloudflare, Check Point, AWS, Google, Microsoft, and Intel.",
      "$12 million",
    );
    expect(out.lead_investors).toEqual(["Blackstone Innovations Investments"]);
    expect(out.other_investors).toEqual([]);
    expect(out.dropped).toEqual(["Cloudflare", "Check Point", "AWS", "Google", "Microsoft", "Intel"]);
    const works = clean([], ["Mayo Clinic", "Sequoia Capital"], "Acme, which works with Mayo Clinic, raised $5M from Sequoia Capital.");
    expect(works.other_investors).toEqual(["Sequoia Capital"]);
    expect(works.dropped).toEqual(["Mayo Clinic"]);
  });

  test("a prior clause gives way to this round's clause; 'previously undisclosed' describes this round", () => {
    const turns = clean([], ["Accel", "Sequoia Capital"], "Previously backed by Accel, the round was led by Sequoia Capital.");
    expect(turns.lead_investors).toEqual(["Sequoia Capital"]);
    expect(turns.dropped).toEqual(["Accel"]);
    const undisclosed = clean([], ["Accel"], "Acme raised a previously undisclosed seed round led by Accel.");
    expect(undisclosed.lead_investors).toEqual(["Accel"]);
    // Early backers who joined again are participants.
    const rejoined = clean(["Sequoia Capital"], ["Accel"], "Acme raised $5M led by Sequoia Capital. Early backers Accel also joined.");
    expect(rejoined.other_investors).toEqual(["Accel"]);
    const participating = clean(
      ["Sequoia Capital"],
      ["Accel"],
      "Acme raised $5M led by Sequoia Capital, with participation from early backers Accel.",
    );
    expect(participating.other_investors).toEqual(["Accel"]);
  });
});

describe("shape", () => {
  test("empty lists and empty evidence", () => {
    expect(clean([], [], "")).toEqual({ lead_investors: [], other_investors: [], dropped: [] });
  });

  test("blank and punctuation-only entries drop, order is preserved otherwise", () => {
    const out = clean(
      ["Sequoia Capital", "  "],
      ["Index Ventures.", "and Accel"],
      "Acme raised $5M led by Sequoia Capital with Index Ventures and Accel.",
    );
    expect(out.lead_investors).toEqual(["Sequoia Capital"]);
    expect(out.other_investors).toEqual(["Index Ventures", "Accel"]);
    expect(out.dropped).toEqual(["  "]);
  });
});

describe("normalizeInvestorName", () => {
  test("the phrasing a verdict or a fill copies off the page resolves to the firm, a placeholder to null", () => {
    expect(normalizeInvestorName("Growth Equity at Goldman Sachs Alternatives")).toBe("Goldman Sachs Alternatives");
    expect(normalizeInvestorName("funds and accounts managed by BlackRock")).toBe("BlackRock");
    expect(normalizeInvestorName("accounts advised by T. Rowe Price Associates")).toBe("T. Rowe Price Associates");
    // The acronym after the owner is not part of the wrapped name, whichever apostrophe the page used.
    expect(normalizeInvestorName("Business Development Bank of Canada's (BDC) Industrial Innovation Venture Fund")).toBe(
      "Industrial Innovation Venture Fund",
    );
    expect(normalizeInvestorName("Business Development Bank of Canada’s Industrial Innovation Venture Fund")).toBe(
      "Industrial Innovation Venture Fund",
    );
    expect(normalizeInvestorName("undisclosed investors")).toBeNull();
  });

  test("a trailing parenthetical that describes the firm strips; a bare acronym stays for the merge rules", () => {
    expect(normalizeInvestorName("Grey Silo Ventures (CVC of Cereal Docks Group)")).toBe("Grey Silo Ventures");
    expect(normalizeInvestorName("Acme Ventures (formerly Acme Labs)")).toBe("Acme Ventures");
    expect(normalizeInvestorName("Andreessen Horowitz (a16z)")).toBe("Andreessen Horowitz (a16z)");
  });

  test("a place's possessive is where the investor is: the name after it stands alone", () => {
    expect(normalizeInvestorName("Singapore's GIC")).toBe("GIC");
    expect(normalizeInvestorName("Singapore’s GIC")).toBe("GIC");
    expect(normalizeInvestorName("Abu Dhabi’s MGX")).toBe("MGX");
    expect(normalizeInvestorName("the UAE's MGX")).toBe("MGX");
    expect(normalizeInvestorName("Canada’s OTPP")).toBe("OTPP");
    expect(normalizeInvestorName("France's Source Ventures")).toBe("Source Ventures");
    expect(normalizeInvestorName("India’s National Quantum Mission")).toBe("National Quantum Mission");
    // Nothing left that names an investor on its own: the place stays part of the name.
    expect(normalizeInvestorName("Kuwait’s Investment Authority")).toBe("Kuwait’s Investment Authority");
    // An owner's possessive, a possessive inside a name, and a place inside a longer name are not places.
    expect(normalizeInvestorName("Alphabet's CapitalG")).toBe("Alphabet's CapitalG");
    expect(normalizeInvestorName("Microsoft’s M12")).toBe("Microsoft’s M12");
    expect(normalizeInvestorName("Monk's Hill Ventures")).toBe("Monk's Hill Ventures");
    expect(normalizeInvestorName("Founder’s Fund")).toBe("Founder’s Fund");
    expect(normalizeInvestorName("Media City Qatar's Next Ventures")).toBe("Media City Qatar's Next Ventures");
  });
});

describe("investorMentions", () => {
  test("a name counts when its head or its identity key stands as whole words in the text", () => {
    const page = investorMentions(
      "The Bengaluru company counts Lingotto, Qualcomm, Zoho Corporation and a16z among its backers, and Walden International chairman Lip-Bu Tan invested.",
    );
    expect(page("Lingotto")).toBe(true);
    // The identity key: "Qualcomm Ventures" is named as "Qualcomm".
    expect(page("Qualcomm Ventures")).toBe(true);
    expect(page("Lip-Bu Tan")).toBe(true);
    // A record's short form meets the page's full name.
    expect(investorMentions("Andreessen Horowitz led the round.")("a16z")).toBe(true);
    expect(page("Zoho")).toBe(true);
    expect(page("Yali Capital")).toBe(false);
    // Whole words only: "Zo" is not in "Zoho".
    expect(page("Zo Ventures")).toBe(false);
    expect(investorMentions("Entrée Capital joined.")("Entree Capital")).toBe(true);
  });
});

// The pre-launch audit (September 2026) found these in the investor directory, each its own page.
describe("descriptions of investors, crowds of a firm, and owner-wrapped names", () => {
  test("a description of investors is nobody in particular", () => {
    for (const name of [
      "executives from OpenAI",
      "a syndicated group of individual investors",
      "some business angels",
      "two American private investors",
      "a conglomerate of private investors",
      "a large US-based West Coast mutual fund manager",
      "a notable Sovereign Wealth Fund",
      "a Swiss single family office",
      "certain members of the company’s management team",
      "the ex-founder of Shutterstock",
      "German business angels",
      "two Kellogg angels",
      "associates of Smead Capital Management",
      "partners of DST Global",
    ])
      expect(normalizeInvestorName(name), name).toBeNull();
  });

  test("a firm's own capitalized name stays, even when it opens on a count or ends on a crowd word", () => {
    for (const name of [
      "Two Sigma Ventures",
      "Three Words Capital",
      "A-Star Capital",
      "Stanford Angels",
      "QED Investors",
      "Monk's Hill Ventures",
    ])
      expect(normalizeInvestorName(name), name).toBe(name);
  });

  test("an owner's vehicle named through descriptor words is the vehicle; a family office with no name is the owner", () => {
    expect(normalizeInvestorName("Microsoft’s venture arm M12")).toBe("M12");
    expect(normalizeInvestorName("Kevin Hart's firm Hartbeat Ventures")).toBe("Hartbeat Ventures");
    expect(normalizeInvestorName("Temasek's early-stage investment platform Xora")).toBe("Xora");
    expect(normalizeInvestorName("Tobias Lütke’s family office")).toBe("Tobias Lütke");
    expect(normalizeInvestorName("affiliated funds of BlackRock")).toBe("BlackRock");
    expect(normalizeInvestorName("Latitude, the growth fund of Phoenix Court")).toBe("Latitude");
  });

  test("keys: a possessive, an & Co. tail, a leading 'the', and a program word do not make a new investor", () => {
    expect(investorKeyForMerge("a16z’s Speedrun accelerator")).toBe("andreessen horowitz speedrun");
    expect(investorKeyForMerge("a16z speedrun")).toBe("andreessen horowitz speedrun");
    expect(investorKeyForMerge("a16z CSX")).toBe("andreessen horowitz speedrun");
    expect(investorKeyForMerge("a16z crypto")).toBe("andreessen horowitz crypto");
    expect(investorKeyForMerge("Wells Fargo & Co")).toBe("wells fargo");
    expect(investorKeyForMerge("Slauson & Co.")).toBe("slauson");
    // A lowercase "the" is the sentence's article and leaves the name; a capital "The" is the firm's own.
    expect(normalizeInvestorName("the University of Michigan")).toBe("University of Michigan");
    expect(normalizeInvestorName("The Column Group")).toBe("The Column Group");
    expect(normalizeInvestorName("the same private investment group")).toBeNull();
    // A region is a firm of its own: Sequoia's India and China arms have been separate firms since 2023.
    expect(investorKeyForMerge("Sequoia Capital India")).not.toBe(investorKeyForMerge("Sequoia Capital"));
  });
});

describe("display hygiene", () => {
  test("an exchange ticker, a trademark sign, and a trailing legal form leave the shown name", () => {
    expect(normalizeInvestorName("Eli Lilly (NYSE: LLY)")).toBe("Eli Lilly");
    expect(normalizeInvestorName("Acme Robotics, Nasdaq: ACME")).toBe("Acme Robotics");
    expect(normalizeInvestorName("Energy Capital Ventures®")).toBe("Energy Capital Ventures");
    expect(normalizeInvestorName("GordonMD Global Investments® LP")).toBe("GordonMD Global Investments");
    expect(normalizeInvestorName("Arm Holdings Inc")).toBe("Arm Holdings");
    expect(normalizeInvestorName("Seika Daiya Engine Co., Ltd")).toBe("Seika Daiya Engine");
    expect(normalizeInvestorName("HSBC Holdings plc")).toBe("HSBC Holdings");
    expect(normalizeInvestorName("Cyberstarts Opportunity Fund, LP")).toBe("Cyberstarts Opportunity Fund");
  });

  test("a brand's own form stays, and so does a form that is the only thing saying it is a company", () => {
    expect(normalizeInvestorName("Slauson & Co")).toBe("Slauson & Co");
    expect(normalizeInvestorName("Investor AB")).toBe("Investor AB");
    expect(normalizeInvestorName("Fred Olsen Ltd")).toBe("Fred Olsen Ltd");
    expect(normalizeInvestorName("Realty Corporation")).toBe("Realty Corporation");
    // A name that ends on "&" is a brand too: X& is a Japanese fund.
    expect(normalizeInvestorName("X&")).toBe("X&");
  });

  test("an honorific and the description before it leave a person's name; a company named for a doctor stays", () => {
    expect(normalizeInvestorName("Dr Michael Boyer")).toBe("Michael Boyer");
    expect(normalizeInvestorName("Chris O’Brien Lifehouse CEO Professor Michael Boyer")).toBe("Michael Boyer");
    expect(normalizeInvestorName("orthopaedic surgeon Dr Michael Solomon")).toBe("Michael Solomon");
    expect(normalizeInvestorName("Dr. Reddy's Laboratories")).toBe("Dr. Reddy's Laboratories");
  });

  test("an owner's investing arm named without the possessive is the arm; a former name in parentheses goes", () => {
    expect(normalizeInvestorName("Relativity investment arm Rel Labs")).toBe("Rel Labs");
    expect(normalizeInvestorName("YZi Labs (ex Binance Labs)")).toBe("YZi Labs");
  });

  test("the investor key keeps AI and Labs, so another firm cannot land on the shorter brand", () => {
    expect(investorKeyForMerge("Sovereign AI")).toBe("sovereign ai");
    expect(investorKeyForMerge("Sovereign AI Fund")).toBe("sovereign ai");
    expect(investorKeyForMerge("Sovereign’s Capital")).toBe("sovereign");
    expect(investorKeyForMerge("FJ Labs")).toBe("fj labs");
    expect(normalizeCompanyKey("Acme AI")).toBe("acme");
  });
});
