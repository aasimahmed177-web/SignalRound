// The SEC Form D lane against a fake EDGAR (addressing, paging, and spans are tested in
// packages/core): the search response and primary_doc.xml shapes as
// fixtures, the fund and small-sale skips, amendments against their predecessor, and the item
// shape resolving to a kept, publishable record sourced from sec.gov at tier 1. The gate's newer
// rules (corporations only, no public issuers, no business combinations, equity not options or
// notes alone, no single-investor small sales) each run against a live primary_doc.xml under
// tests/fixtures/form-d, the filings of the 2026-09-04 data audit.

import { readFileSync } from "node:fs";
import {
  EdgarClient,
  FORM_D_VEHICLE_NAME,
  filingIndexUrl,
  formDDisposition,
  formDIsCorporation,
  formDItem,
  formDTitle,
  hitIsPooledFund,
  hitIsPublicIssuer,
  materialChange,
  normalizeCompanyKey,
  parseFormD,
  resolveRounds,
  runFormD,
  searchFormD,
  searchUrl,
  splitByDisposition,
  splitDisplayName,
  submissionsArePublic,
} from "@fireround/core";
import { describe, expect, test } from "vitest";
import { coverageFor } from "../lib/coverage";
import { formDWindow, laneDue, lanesDue } from "../lib/lanes";

const NOW = new Date("2026-09-04T12:00:00Z");

interface Fixture {
  cik: string;
  adsh: string;
  form: "D" | "D/A";
  fileDate: string;
  items: string[];
  name: string;
  xml: string;
}

function xml(o: {
  name: string;
  city?: string;
  state?: string;
  stateDesc?: string;
  industry: string;
  offering: string;
  sold: string;
  firstSale?: string | null;
  amendment?: boolean;
  equity?: boolean;
  debt?: boolean;
  pooled?: boolean;
  investors?: number;
}): string {
  const firstSale = o.firstSale === null ? "<yetToOccur>true</yetToOccur>" : `<value>${o.firstSale ?? "2026-08-28"}</value>`;
  return `<?xml version="1.0"?>
<edgarSubmission>
  <schemaVersion>X0708</schemaVersion>
  <submissionType>${o.amendment ? "D/A" : "D"}</submissionType>
  <testOrLive>LIVE</testOrLive>
  <primaryIssuer>
    <cik>0001234567</cik>
    <entityName>${o.name}</entityName>
    <issuerAddress>
      <street1>1 MAIN ST</street1>
      <city>${o.city ?? "SAN FRANCISCO"}</city>
      <stateOrCountry>${o.state ?? "CA"}</stateOrCountry>
      <stateOrCountryDescription>${o.stateDesc ?? "CALIFORNIA"}</stateOrCountryDescription>
      <zipCode>94105</zipCode>
    </issuerAddress>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc>
    <entityType>Corporation</entityType>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Ada</firstName><lastName>Lovelace</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Director</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Grace</firstName><middleName>B</middleName><lastName>Hopper</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>${o.industry}</industryGroupType></industryGroup>
    <federalExemptionsExclusions><item>06b</item></federalExemptionsExclusions>
    <typeOfFiling>
      <newOrAmendment><isAmendment>${o.amendment ? "true" : "false"}</isAmendment></newOrAmendment>
      <dateOfFirstSale>${firstSale}</dateOfFirstSale>
    </typeOfFiling>
    <typesOfSecuritiesOffered>
      <isEquityType>${o.equity === false ? "false" : "true"}</isEquityType>
      ${o.debt ? "<isDebtType>true</isDebtType>" : ""}
      ${o.pooled ? "<isPooledInvestmentFundType>true</isPooledInvestmentFundType>" : ""}
    </typesOfSecuritiesOffered>
    <offeringSalesAmounts>
      <totalOfferingAmount>${o.offering}</totalOfferingAmount>
      <totalAmountSold>${o.sold}</totalAmountSold>
      <totalRemaining>0</totalRemaining>
    </offeringSalesAmounts>
    <investors>
      <hasNonAccreditedInvestors>false</hasNonAccreditedInvestors>
      <totalNumberAlreadyInvested>${o.investors ?? 12}</totalNumberAlreadyInvested>
    </investors>
  </offeringData>
</edgarSubmission>`;
}

const FIXTURES: Fixture[] = [
  {
    cik: "0001234567",
    adsh: "0001234567-26-000001",
    form: "D",
    fileDate: "2026-09-03",
    items: ["06B"],
    name: "Acme Robotics, Inc.",
    xml: xml({ name: "Acme Robotics, Inc.", industry: "Other Technology", offering: "5000000", sold: "4600000" }),
  },
  {
    cik: "0001234568",
    adsh: "0001234568-26-000001",
    form: "D",
    fileDate: "2026-09-03",
    items: ["06B"],
    name: "Tiny Bakery LLC",
    xml: xml({ name: "Tiny Bakery LLC", industry: "Restaurants", offering: "500000", sold: "250000" }),
  },
  {
    cik: "0001234569",
    adsh: "0001234569-26-000001",
    form: "D",
    fileDate: "2026-09-03",
    items: ["06B", "3C", "3C.7"],
    name: "Growth Fund IV, L.P.",
    xml: xml({ name: "Growth Fund IV, L.P.", industry: "Pooled Investment Fund", offering: "Indefinite", sold: "80000000", pooled: true }),
  },
  {
    cik: "0001234570",
    adsh: "0001234570-26-000002",
    form: "D/A",
    fileDate: "2026-09-04",
    items: ["06B"],
    name: "Beta Health Ltd",
    xml: xml({
      name: "Beta Health Ltd",
      city: "LONDON",
      state: "X0",
      stateDesc: "UNITED KINGDOM",
      industry: "Biotechnology",
      offering: "20000000",
      sold: "12000000",
      amendment: true,
      debt: true,
    }),
  },
  {
    cik: "0001234571",
    adsh: "0001234571-26-000002",
    form: "D/A",
    fileDate: "2026-09-04",
    items: ["06B"],
    name: "Gamma Unchanged Corp",
    xml: xml({ name: "Gamma Unchanged Corp", industry: "Other", offering: "3000000", sold: "3000000", amendment: true }),
  },
  {
    // A listed issuer: EDGAR puts the ticker on the hit, so the run skips it before reading the XML.
    cik: "0001234572",
    adsh: "0001234572-26-000001",
    form: "D",
    fileDate: "2026-09-04",
    items: ["06B"],
    name: "Listed Pharma, Inc.  (LSTD)",
    xml: xml({ name: "Listed Pharma, Inc.", industry: "Pharmaceuticals", offering: "50000000", sold: "50000000" }),
  },
  {
    // A listed issuer whose hit has no ticker: the amendment path reads its submissions index, which does.
    cik: "0001234573",
    adsh: "0001234573-26-000002",
    form: "D/A",
    fileDate: "2026-09-04",
    items: ["06B"],
    name: "Delta Public Corp",
    xml: xml({ name: "Delta Public Corp", industry: "Other Technology", offering: "40000000", sold: "30000000", amendment: true }),
  },
];

/** The predecessor filings the amendments are measured against, and the issuer's tickers where it has any. */
const PREDECESSORS: Record<string, { adsh: string; fileDate: string; xml: string; tickers?: string[] }> = {
  "0001234570": {
    adsh: "0001234570-26-000001",
    fileDate: "2026-06-01",
    xml: xml({ name: "Beta Health Ltd", industry: "Biotechnology", offering: "20000000", sold: "4000000" }),
  },
  "0001234571": {
    adsh: "0001234571-26-000001",
    fileDate: "2026-06-01",
    xml: xml({ name: "Gamma Unchanged Corp", industry: "Other", offering: "3000000", sold: "2900000" }),
  },
  "0001234573": {
    adsh: "0001234573-26-000001",
    fileDate: "2026-06-01",
    xml: xml({ name: "Delta Public Corp", industry: "Other Technology", offering: "40000000", sold: "10000000" }),
    tickers: ["DLTA"],
  },
};

function searchResponse(hits: Fixture[]) {
  return {
    hits: {
      total: { value: hits.length, relation: "eq" },
      hits: hits.map((h) => ({
        _id: `${h.adsh}:primary_doc.xml`,
        _source: {
          ciks: [h.cik],
          display_names: [`${h.name}  (CIK ${h.cik})`],
          file_date: h.fileDate,
          form: h.form,
          adsh: h.adsh,
          items: h.items,
        },
      })),
    },
  };
}

function fakeFetch(log: Array<{ url: string; ua: string | undefined }> = []) {
  return async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
    log.push({ url, ua: init?.headers?.["User-Agent"] });
    if (url.startsWith("https://efts.sec.gov/LATEST/search-index")) {
      return new Response(JSON.stringify(searchResponse(FIXTURES)), { status: 200 });
    }
    const sub = /data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (sub) {
      const p = PREDECESSORS[sub[1]];
      const current = FIXTURES.find((f) => f.cik === sub[1]);
      if (!p || !current) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          tickers: p.tickers ?? [],
          filings: {
            recent: {
              accessionNumber: [current.adsh, p.adsh, "0001234570-25-000009"],
              form: [current.form, "D", "8-K"],
              filingDate: [current.fileDate, p.fileDate, "2025-01-01"],
              primaryDocument: ["primary_doc.xml", "primary_doc.xml", "x.htm"],
            },
          },
        }),
        { status: 200 },
      );
    }
    const doc = /edgar\/data\/(\d+)\/(\d{18})\/primary_doc\.xml$/.exec(url);
    if (doc) {
      const cik = doc[1].padStart(10, "0");
      const fixture = FIXTURES.find((f) => f.cik === cik && f.adsh.replace(/-/g, "") === doc[2]);
      if (fixture) return new Response(fixture.xml, { status: 200 });
      const p = PREDECESSORS[cik];
      if (p && p.adsh.replace(/-/g, "") === doc[2]) return new Response(p.xml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

const hitOf = (f: Fixture) => ({
  adsh: f.adsh,
  cik: f.cik,
  form: f.form,
  fileDate: f.fileDate,
  items: f.items,
  displayName: f.name,
  ticker: null,
});

/** A live primary_doc.xml from EDGAR, one of the ten filings the data audit read (plus Corvex). */
const live = (slug: string) => parseFormD(readFileSync(new URL(`./fixtures/form-d/${slug}.xml`, import.meta.url), "utf8"));

describe("parseFormD", () => {
  test("reads issuer, address, industry, amounts, first sale, amendment flag, securities, persons", () => {
    const f = parseFormD(FIXTURES[0].xml);
    expect(f).toMatchObject({
      issuer: "Acme Robotics, Inc.",
      city: "SAN FRANCISCO",
      stateOrCountry: "CA",
      stateOrCountryDescription: "CALIFORNIA",
      industryGroup: "Other Technology",
      totalOfferingAmount: 5_000_000,
      offeringIndefinite: false,
      totalAmountSold: 4_600_000,
      dateOfFirstSale: "2026-08-28",
      isAmendment: false,
      isBusinessCombination: false,
      entityType: "Corporation",
      entityTypeOtherDesc: null,
      securityTypes: ["equity"],
      investorCount: 12,
    });
    expect(f.relatedPersons).toEqual([
      { name: "Ada Lovelace", relationships: ["Executive Officer", "Director"] },
      { name: "Grace B Hopper", relationships: ["Director"] },
    ]);
  });

  test("an indefinite offering, a pooled fund, a sale yet to occur, and a missing document all parse to nulls, not throws", () => {
    const fund = parseFormD(FIXTURES[2].xml);
    expect(fund.totalOfferingAmount).toBeNull();
    expect(fund.offeringIndefinite).toBe(true);
    expect(fund.securityTypes).toEqual(["equity", "pooled investment fund interests"]);
    const pending = parseFormD(xml({ name: "Soon Co", industry: "Other", offering: "1000000", sold: "0", firstSale: null }));
    expect(pending.dateOfFirstSale).toBeNull();
    expect(parseFormD("")).toMatchObject({
      issuer: "",
      entityType: null,
      entityTypeOtherDesc: null,
      totalAmountSold: null,
      isBusinessCombination: false,
      relatedPersons: [],
      securityTypes: [],
    });
  });

  test("a live filing: entity type Other with its description, Item 10, options with the securities they acquire", () => {
    expect(live("big-auto")).toMatchObject({
      issuer: "Big Auto - Accident Attorneys PLLC",
      entityType: "Other",
      entityTypeOtherDesc: "Professional Limited Liability Company",
      industryGroup: "Other",
      totalAmountSold: 2_300_000,
      investorCount: 6,
      securityTypes: ["equity"],
    });
    expect(live("switchboard-health")).toMatchObject({ entityType: "Corporation", isBusinessCombination: true, investorCount: 7 });
    expect(live("gossamer-bio").securityTypes).toEqual(["options", "securities to be acquired"]);
    expect(live("archaius").securityTypes).toEqual(["simple agreement for future equity"]);
  });
});

describe("splitDisplayName", () => {
  test("a reporting company's hit carries its ticker between the name and the CIK; a private issuer's does not", () => {
    expect(splitDisplayName("Gossamer Bio, Inc.  (GOSS)  (CIK 0001728117)")).toEqual({ name: "Gossamer Bio, Inc.", ticker: "GOSS" });
    expect(splitDisplayName("Corvex, Inc.  (MOVE)  (CIK 0001734750)")).toEqual({ name: "Corvex, Inc.", ticker: "MOVE" });
    expect(splitDisplayName("FuriosaAI, Inc.  (CIK 0002149195)")).toEqual({ name: "FuriosaAI, Inc.", ticker: null });
    // A parenthetical inside the name is set off by one space, not EDGAR's two.
    expect(splitDisplayName("Acme (USA) LLC  (CIK 0000000001)")).toEqual({ name: "Acme (USA) LLC", ticker: null });
    expect(hitIsPublicIssuer({ ticker: "GOSS" })).toBe(true);
    expect(hitIsPublicIssuer({ ticker: null })).toBe(false);
  });

  test("searchFormD reads the ticker off the hit", async () => {
    const fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify(
          searchResponse([{ ...FIXTURES[0], cik: "0001728117", adsh: "0001728117-26-000088", name: "Gossamer Bio, Inc.  (GOSS)" }]),
        ),
        { status: 200 },
      );
    const [hit] = await searchFormD(new EdgarClient({ fetch, requestsPerSecond: 10_000 }), new Date(), new Date());
    expect(hit).toMatchObject({ displayName: "Gossamer Bio, Inc.", ticker: "GOSS" });
  });
});

describe("formDDisposition", () => {
  const parsed = FIXTURES.map((f) => parseFormD(f.xml));
  test("keeps a new filing at or above $1M", () => {
    expect(formDDisposition(parsed[0])).toBeNull();
  });
  test("skips small sales and pooled investment funds; the search hit's 3C items skip the fund before any fetch", () => {
    expect(formDDisposition(parsed[1])).toBe("small_sale");
    expect(formDDisposition(parsed[2])).toBe("pooled_fund");
    expect(hitIsPooledFund(hitOf(FIXTURES[2]))).toBe(true);
    expect(hitIsPooledFund(hitOf(FIXTURES[0]))).toBe(false);
  });
  test("real estate vehicles, funds, and projects are not operating companies", () => {
    const acme = parsed[0];
    expect(formDDisposition({ ...acme, industryGroup: "REITS and Finance" })).toBe("not_operating_company");
    expect(formDDisposition({ ...acme, industryGroup: "Residential" })).toBe("not_operating_company");
    expect(formDDisposition({ ...acme, industryGroup: "Commercial" })).toBe("not_operating_company");
    expect(formDDisposition({ ...acme, industryGroup: "Investing" })).toBe("not_operating_company");
    expect(formDDisposition({ ...acme, industryGroup: "Other Technology" })).toBeNull();
    expect(formDDisposition({ ...acme, industryGroup: "Biotechnology" })).toBeNull();
    expect(formDDisposition({ ...acme, industryGroup: null })).toBeNull();
    for (const name of [
      "Project Edison 55 at Dripping Springs LLC",
      "Exalted Opportunities Fund I, LLC",
      "Energy Domain Partners II, LP",
      "Blue Ridge Apartments Investors LLC",
      "Acme Ventures III LLC",
      "Series 7 of Alpha Holdings LLC",
      // Co-investment vehicles, SPVs, numbered funds, and property addresses (a street number then a street word, or a name ending in one).
      "RMJVT LTH Co-Invest LLC",
      "Acme Coinvestment Partners LLC",
      "Acme SPV I LLC",
      "Blue Fund II, L.P.",
      "1250 Main Street LLC",
      "10 Downing St. Partners",
      "MI Macomb Gratiot Ave, LLC",
    ]) {
      expect(formDDisposition({ ...acme, issuer: name }), name).toBe("vehicle_name");
    }
    for (const name of [
      "Acme Robotics, Inc.",
      "Lupa Pets Ltd",
      "Gimlet Labs Inc",
      "Nscale Ltd",
      // A street word inside a name, a state code, a digit glued to a word, and a number before a non-street word are not addresses.
      "Sesame Street Learning Inc",
      "Solar CT LLC",
      "AlgoX2 Corp",
      "3 Way Technologies Inc",
      "Highway 9 Inc",
      "Westland Inc",
    ]) {
      expect(FORM_D_VEHICLE_NAME.test(name), name).toBe(false);
      expect(formDDisposition({ ...acme, issuer: name }), name).toBeNull();
    }
  });
  test("an amendment is kept only when the amount sold moved materially against its predecessor", () => {
    expect(formDDisposition(parsed[3], { previousSold: 4_000_000 })).toBeNull();
    expect(formDDisposition(parsed[4], { previousSold: 2_900_000 })).toBe("amendment_unchanged");
    expect(formDDisposition(parsed[3])).toBe("amendment_no_predecessor");
    expect(formDDisposition(parsed[3], { previousSold: null })).toBeNull();
    expect(materialChange(5_000_000, 4_500_000)).toBe(false);
    expect(materialChange(5_000_000, 4_000_000)).toBe(true);
    expect(materialChange(1_200_000, 1_000_000)).toBe(true);
  });
});

describe("formDDisposition: the audit's gate, each rule against a live filing", () => {
  const acme = parseFormD(FIXTURES[0].xml);

  test("not_corporation: LLCs, PLLCs, and other non-corporate entities are vehicles or practices", () => {
    expect(formDDisposition(live("egt-26"))).toBe("not_corporation");
    expect(formDDisposition(live("big-auto"))).toBe("not_corporation");
    // Named like a vehicle too; the name rule comes first, and the entity type would skip them anyway.
    expect(formDDisposition({ ...live("mi-macomb-gratiot"), issuer: "Macomb Group, LLC" })).toBe("not_corporation");
    // A holdco or parent entity is a vehicle by its name (Stonepeak Nile Parent LLC, pre-launch audit).
    expect(formDDisposition({ ...live("mi-macomb-gratiot"), issuer: "Macomb Holdco, LLC" })).toBe("vehicle_name");
    expect(formDDisposition({ ...live("rmjvt-lth-co-invest"), issuer: "RMJVT LTH LLC" })).toBe("not_corporation");
    expect(formDIsCorporation({ entityType: "Limited Partnership", entityTypeOtherDesc: null })).toBe(false);
    expect(formDIsCorporation({ entityType: "Business Trust", entityTypeOtherDesc: null })).toBe(false);
    expect(formDIsCorporation({ entityType: "Other", entityTypeOtherDesc: "Professional Limited Liability Company" })).toBe(false);
    // A foreign form the filer names as a corporation passes; a filing without the tag is not judged on it.
    expect(formDIsCorporation({ entityType: "Other", entityTypeOtherDesc: "Korean corporation (chusik hoesa)" })).toBe(true);
    expect(formDIsCorporation({ entityType: null, entityTypeOtherDesc: null })).toBe(true);
    for (const slug of ["furiosaai", "switchboard-health", "archaius", "algox2", "corvex"]) {
      expect(formDIsCorporation(live(slug)), slug).toBe(true);
    }
  });

  test("options_or_warrants: options with no equity are a grant or a warrant deal; equity plus options is a round", () => {
    expect(formDDisposition(live("algox2"))).toBe("options_or_warrants");
    // Read from its XML alone, Gossamer's placement is options and the shares under them; the hit's ticker skips it earlier in a run.
    expect(formDDisposition(live("gossamer-bio"))).toBe("options_or_warrants");
    expect(formDDisposition({ ...acme, securityTypes: ["equity", "options"] })).toBeNull();
  });

  test("business_combination: Item 10 checked is financing tied to a merger or acquisition", () => {
    expect(formDDisposition(live("switchboard-health"))).toBe("business_combination");
    expect(formDDisposition({ ...live("switchboard-health"), isBusinessCombination: false })).toBeNull();
  });

  test("public_issuer: a ticker on the hit, or tickers or a 10-K or 10-Q in the submissions index", () => {
    expect(formDDisposition(live("gossamer-bio"), { publicIssuer: true })).toBe("public_issuer");
    expect(formDDisposition(live("corvex"), { publicIssuer: true })).toBe("public_issuer");
    expect(formDDisposition(live("corvex"), { publicIssuer: false })).toBeNull();
    expect(submissionsArePublic({ tickers: ["GOSS"], filings: { recent: { form: ["D", "8-K", "10-Q"] } } })).toBe(true);
    expect(submissionsArePublic({ tickers: [], filings: { recent: { form: ["D", "8-K", "10-K/A"] } } })).toBe(true);
    expect(submissionsArePublic({ tickers: [], filings: { recent: { form: ["D", "D/A"] } } })).toBe(false);
    expect(submissionsArePublic({ filings: { recent: { form: [] } } })).toBe(false);
  });

  test("single_investor_small: one investor under $5M is a SAFE or a cheque; one investor at $5M and up is news", () => {
    expect(formDDisposition(live("archaius"))).toBe("single_investor_small");
    // Labs Companies: equity and an "EDGE Note", $1.5M of a $5B offering to one investor.
    expect(formDDisposition(live("labs-companies"))).toBe("single_investor_small");
    // FuriosaAI: $5,119,349 to one investor clears the bar.
    expect(formDDisposition(live("furiosaai"))).toBeNull();
    // A $33M sale to one investor is a round whatever the count.
    expect(formDDisposition({ ...live("corvex"), investorCount: 1 })).toBeNull();
    expect(formDDisposition({ ...acme, investorCount: 1 })).toBe("single_investor_small");
    expect(formDDisposition({ ...acme, investorCount: 2 })).toBeNull();
    expect(formDDisposition({ ...acme, investorCount: null })).toBeNull();
  });

  test("debt_only: debt or notes alone are a lender's paper; equity beside a note is still equity", () => {
    const labs = live("labs-companies");
    const noteOnly = { ...labs, securityTypes: labs.securityTypes.filter((t) => t !== "equity"), investorCount: 4 };
    expect(noteOnly.securityTypes).toHaveLength(1);
    expect(formDDisposition(noteOnly)).toBe("debt_only");
    expect(formDDisposition({ ...acme, securityTypes: ["debt"] })).toBe("debt_only");
    expect(formDDisposition({ ...acme, securityTypes: ["debt", "convertible promissory notes"] })).toBe("debt_only");
    expect(formDDisposition({ ...acme, securityTypes: ["equity", "debt"] })).toBeNull();
    expect(formDDisposition({ ...acme, securityTypes: ["simple agreement for future equity"] })).toBeNull();
    expect(formDDisposition({ ...acme, securityTypes: [] })).toBeNull();
  });

  test("the audit's ten: one filing passes on its XML alone, and Corvex would have been skipped on its hit", () => {
    const verdicts = Object.fromEntries(
      [
        "algox2",
        "archaius",
        "big-auto",
        "labs-companies",
        "egt-26",
        "furiosaai",
        "gossamer-bio",
        "mi-macomb-gratiot",
        "rmjvt-lth-co-invest",
        "switchboard-health",
      ].map((slug) => [slug, formDDisposition(live(slug))]),
    );
    expect(verdicts).toEqual({
      algox2: "options_or_warrants",
      archaius: "single_investor_small",
      "big-auto": "not_corporation",
      "labs-companies": "single_investor_small",
      "egt-26": "not_corporation",
      furiosaai: null,
      "gossamer-bio": "options_or_warrants",
      "mi-macomb-gratiot": "vehicle_name",
      "rmjvt-lth-co-invest": "vehicle_name",
      "switchboard-health": "business_combination",
    });
    expect(formDDisposition(live("corvex"))).toBeNull();
    expect(hitIsPublicIssuer(splitDisplayName("Corvex, Inc.  (MOVE)  (CIK 0001734750)"))).toBe(true);
  });

  test("the company key keeps a leading suffix word: Labs Companies is not 'companies', Acme Labs Inc is still 'acme'", () => {
    expect(normalizeCompanyKey("Labs Companies, Inc.")).toBe("labs companies");
    expect(normalizeCompanyKey("Acme Labs Inc")).toBe("acme");
    expect(normalizeCompanyKey("Gimlet Labs, Inc.")).toBe("gimlet");
    expect(normalizeCompanyKey("AI")).toBe("ai");
    const item = formDItem(live("labs-companies"), { ...hitOf(FIXTURES[0]), fileDate: "2026-09-04" });
    const rec = resolveRounds([item], { stages: ["other"], windowStart: new Date("2026-08-05T00:00:00Z"), now: NOW }).kept[0];
    expect(rec.id).toBe("labs-companies:other:2026-09-03");
  });
});

describe("formDItem and resolveRounds", () => {
  test("the item resolves to a kept, dated record sourced from sec.gov at tier 1 that publishes", () => {
    const item = formDItem(parseFormD(FIXTURES[0].xml), hitOf(FIXTURES[0]));
    expect(item.round).toMatchObject({
      company_name: "Acme Robotics, Inc.",
      round_type_as_written: "Form D (equity)",
      amount_as_written: "$4,600,000",
      amount_kind: "round",
      announced_date: "2026-08-28",
      headquarters: "San Francisco, CA",
      lead_investors: [],
      other_investors: [],
      is_background: false,
      is_rumor: false,
      company_website: null,
      company_description: null,
      sector: null,
      valuation_as_written: null,
      source_url: filingIndexUrl(hitOf(FIXTURES[0])),
    });
    expect(item.round.evidence_quote).toBe(
      "Acme Robotics, Inc. reported in a Form D filed 2026-09-03 that it sold $4,600,000 of equity securities under Regulation D of a $5,000,000 offering (first sale 2026-08-28; 12 investors; Other Technology).",
    );
    expect(item.source).toEqual({
      url: filingIndexUrl(hitOf(FIXTURES[0])),
      host: "sec.gov",
      title: "Form D: Acme Robotics, Inc.",
      published: "2026-09-03",
      query: "formd",
    });

    const windowStart = new Date(NOW.getTime() - 30 * 86_400_000);
    const r = resolveRounds([item], { stages: ["other"], windowStart, now: NOW });
    expect(r.kept).toHaveLength(1);
    const rec = r.kept[0];
    expect(rec.stage).toBe("other");
    expect(rec.stage_as_written).toBe("Form D (equity)");
    expect(rec.amount).toMatchObject({ value: 4.6, currency: "USD", as_written: "$4,600,000" });
    expect(rec.announced_date).toBe("2026-08-28");
    expect(rec.undated).toBe(false);
    expect(rec.sources[0].host).toBe("sec.gov");
    expect(rec.sources[0].title).toBe("Form D: Acme Robotics, Inc.");
    // 0.15 * 1/3 sources + 0.25 dated + 0.30 * 0.5 single-source agreement + 0.20 * tier 1.0 + 0.10 evidence = 0.75.
    expect(rec.confidence).toBe(0.75);
    expect(splitByDisposition([rec]).publish).toHaveLength(1);
    // The same record on an unknown host would sit at 0.61: the tier is what publishes it.
    const elsewhere = resolveRounds([{ ...item, source: { ...item.source, url: "https://filings.example/x", host: "filings.example" } }], {
      stages: ["other"],
      windowStart,
      now: NOW,
    }).kept[0];
    expect(elsewhere.confidence).toBe(0.61);
  });

  test("the stage rule: a Form D label is other even when a share class reads like a series, and the preset's stages drop it", () => {
    const item = formDItem(
      parseFormD(xml({ name: "Series Co", industry: "Other", offering: "9000000", sold: "9000000" })),
      hitOf(FIXTURES[0]),
    );
    item.round.round_type_as_written = "Form D (Series B Preferred)";
    const windowStart = new Date(NOW.getTime() - 30 * 86_400_000);
    expect(resolveRounds([item], { stages: ["other"], windowStart, now: NOW }).kept[0]?.stage).toBe("other");
    expect(resolveRounds([item], { stages: ["series_a", "series_b"], windowStart, now: NOW }).dropped.otherStage).toBe(1);
  });

  test("a foreign issuer's headquarters uses the country; a sale yet to occur is dated by the filing", () => {
    const beta = formDItem(parseFormD(FIXTURES[3].xml), hitOf(FIXTURES[3]));
    expect(beta.round.headquarters).toBe("London, United Kingdom");
    expect(beta.round.round_type_as_written).toBe("Form D (equity, debt)");
    expect(beta.round.evidence_quote).toContain("an amended Form D filed 2026-09-04");
    // The source is titled by form and issuer, dated by the filing, so News and the company page never show a bare URL.
    expect(beta.source.title).toBe("Form D/A: Beta Health Ltd");
    expect(beta.source.published).toBe("2026-09-04");
    expect(formDTitle({ issuer: "Acme Robotics, Inc." }, { form: "D" })).toBe("Form D: Acme Robotics, Inc.");
    const pending = formDItem(
      parseFormD(xml({ name: "Soon Co", industry: "Other", offering: "2000000", sold: "2000000", firstSale: null })),
      hitOf(FIXTURES[0]),
    );
    expect(pending.round.announced_date).toBe("2026-09-03");
    expect(pending.round.evidence_quote).toContain("first sale yet to occur");
  });
});

describe("runFormD", () => {
  test("searches the window, skips seen, fund, and listed hits before fetching, reads the rest, and keeps two of seven", async () => {
    const log: Array<{ url: string; ua: string | undefined }> = [];
    const seen = new Set([filingIndexUrl(hitOf(FIXTURES[1]))]);
    const r = await runFormD(new Date("2026-09-02T00:00:00Z"), NOW, {
      fetch: fakeFetch(log),
      userAgent: "fireround/test (test@example.com)",
      requestsPerSecond: 10_000,
      seen: (url) => seen.has(url),
    });
    expect(r.hits).toBe(7);
    expect(r.skipped).toEqual({
      seen: 1,
      pooled_fund: 1,
      small_sale: 0,
      no_amount: 0,
      amendment_unchanged: 1,
      amendment_no_predecessor: 0,
      not_operating_company: 0,
      vehicle_name: 0,
      not_corporation: 0,
      // One on the hit's ticker (no fetch), one on the amendment's submissions index.
      public_issuer: 2,
      business_combination: 0,
      options_or_warrants: 0,
      debt_only: 0,
      single_investor_small: 0,
      error: 0,
    });
    expect(r.fetched).toBe(4);
    expect(r.kept).toBe(2);
    expect(r.items.map((i) => i.round.company_name).sort()).toEqual(["Acme Robotics, Inc.", "Beta Health Ltd"]);
    // Handled: the fund and the listed issuer (skipped on the hit), the four read. The seen one is not re-marked.
    expect(r.handled.sort()).toEqual([2, 5, 0, 3, 4, 6].map((i) => filingIndexUrl(hitOf(FIXTURES[i]))).sort());
    // 1 search + 4 documents + 3 amendments x (submissions + predecessor document) = 11 requests, every one with the
    // User-Agent. The public-issuer check added none: the ticker rides on the hit, and the amendment path already
    // reads the submissions index for the predecessor.
    expect(r.requests).toBe(11);
    expect(log).toHaveLength(11);
    expect(log.filter((l) => l.url.includes("/CIK0001234572."))).toHaveLength(0);
    expect(log.every((l) => l.ua === "fireround/test (test@example.com)")).toBe(true);
    expect(log[0].url).toBe(searchUrl("2026-09-02", "2026-09-04"));
  });

  test("a document that fails to fetch is counted as an error and left unhandled for the next check", async () => {
    const failing = async (url: string): Promise<Response> =>
      url.includes("efts.sec.gov")
        ? new Response(JSON.stringify(searchResponse([FIXTURES[0]])), { status: 200 })
        : new Response("nope", { status: 503 });
    const r = await runFormD(new Date("2026-09-02T00:00:00Z"), NOW, { fetch: failing, requestsPerSecond: 10_000, seen: () => false });
    expect(r.skipped.error).toBe(1);
    expect(r.handled).toEqual([]);
    expect(r.items).toEqual([]);
  });
});

describe("lane scheduling", () => {
  test("hourly is always due, daily at 06:00 UTC only", () => {
    expect(laneDue("hourly", new Date("2026-09-09T13:00:00Z"))).toBe(true);
    expect(laneDue("daily", new Date("2026-09-09T13:00:00Z"))).toBe(false);
    expect(laneDue("daily", new Date("2026-09-09T06:00:00Z"))).toBe(true);
    expect(laneDue("daily", new Date("2026-09-09T06:59:59Z"))).toBe(true);
  });

  test("lanesDue reads the plan: off at Lite, daily at Deep, hourly at Max", () => {
    const six = new Date("2026-09-09T06:00:00Z");
    const noon = new Date("2026-09-09T12:00:00Z");
    expect(lanesDue(coverageFor("lite"), six)).toEqual({ watch: false, formd: false });
    expect(lanesDue(coverageFor("deep"), six)).toEqual({ watch: true, formd: true });
    expect(lanesDue(coverageFor("deep"), noon)).toEqual({ watch: false, formd: false });
    expect(lanesDue(coverageFor("max"), noon)).toEqual({ watch: true, formd: true });
  });

  test("the Form D window is two days on the daily cadence and three hours on hourly", () => {
    const at = new Date("2026-09-04T12:00:00Z");
    expect(formDWindow("daily", at)).toEqual({ start: new Date("2026-09-02T12:00:00Z"), end: at });
    expect(formDWindow("hourly", at)).toEqual({ start: new Date("2026-09-04T09:00:00Z"), end: at });
  });
});
