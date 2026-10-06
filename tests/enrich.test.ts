// The homepage identity check: a company named "Ollie" is enriched from the Ollie the record
// describes (an AI assistant in San Diego), never from the Ollie the bare name finds first
// (dog food). The search is grounded in the record; every candidate homepage answers
// same_company before its profile, logo, or domain is written.

import {
  CompanyProfile,
  describedAs,
  distinguishingWords,
  enrichCompanies,
  findWebsite,
  hasContext,
  identityPrompt,
  MAX_HOMEPAGE_SCRAPES,
  namesDifferentBusiness,
  websiteQuery,
} from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { clearProfile, clearUnverifiedProfiles, enrichBatch, isPending, isVerified, profileUnverified } from "../lib/enrich";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

const OLLIE = {
  company_key: "ollie",
  company_name: "Ollie",
  company_website: null,
  company_description: "Ollie is a San Diego-based AI assistant that raised $7.5m in seed funding.",
  headquarters: "San Diego, USA",
  sector: "ai",
};

const DOG_FOOD: CompanyProfile = {
  same_company: false,
  identity_reason: "The site sells human-grade dog food subscriptions, not an AI assistant.",
  different_business: "pet food",
  what_they_sell: "Ollie offers personalized, human-grade dog food subscription services.",
  customer_type: "consumer",
  sells_software_subscription: false,
};

const ASSISTANT: CompanyProfile = {
  same_company: true,
  identity_reason: "The site describes an AI assistant built in San Diego, matching the record.",
  different_business: null,
  what_they_sell: "Ollie is an AI assistant that handles email and scheduling for professionals.",
  customer_type: "consumer",
  sells_software_subscription: true,
};

const ZENERGIZE = {
  company_key: "zenergize-technologies",
  company_name: "Zenergize Technologies",
  company_website: "https://zenergize.in",
  company_description: "a deep-tech company developing Silicon Carbide-based power electronics",
  headquarters: "Bengaluru, India",
  sector: "energy",
};

/** The audit's verdict on zenergize.in: false over wording, with no other business named. */
const WORDING_QUIBBLE: CompanyProfile = {
  same_company: false,
  identity_reason: "sells inverters and EV chargers, record says SiC power electronics",
  what_they_sell: "Zenergize sells power electronics such as inverters and EV chargers.",
  customer_type: "hardware or deep tech",
  sells_software_subscription: false,
};

const CONVEO = {
  company_key: "conveo",
  company_name: "Conveo",
  company_website: "https://www.conveo.ai",
  company_description: "an AI-moderated customer interview platform",
  headquarters: "Ghent, Belgium",
  sector: "ai",
};

/** The chrome every real homepage carries, so a fixture page has a page's worth of text. */
const FOOTER =
  "\\n\\nAbout us. Our story and our mission. Leadership and board. Careers: we are hiring across the globe, see open roles. Press and media kit. Blog and stories. Events and webinars. Partners and integrations. Contact sales. Help center and documentation. Status page. Privacy policy. Terms of service. Cookie settings. Accessibility statement. Subscribe to our newsletter for updates. Follow us on social media. Copyright, all rights reserved.";

interface Page {
  json?: unknown;
  links?: string[];
  markdown?: string;
  /** The page as given, with no site chrome added: a thin page. */
  bare?: boolean;
  branding?: { brandName?: string; logo?: string };
  metadata?: { title?: string; favicon?: string };
}

/** A client whose search returns a fixed list and whose scrape answers per host; every call is recorded. */
function fakeClient(searchUrls: string[], pages: Record<string, Page | Error>) {
  const calls: { search: string[]; scrape: string[] } = { search: [], scrape: [] };
  const client = {
    async search(query: string) {
      calls.search.push(query);
      return { web: searchUrls.map((url) => ({ url, title: url })) };
    },
    async scrape(url: string) {
      calls.scrape.push(url);
      const host = new URL(url).hostname.replace(/^www\./, "");
      const page = pages[host];
      if (!page) throw new Error(`no fixture for ${host}`);
      if (page instanceof Error) throw page;
      return { links: [], metadata: { title: host }, ...ownWords(page) };
    },
  };
  return { client: client as unknown as Firecrawl, calls };
}

/** A page that says in its own words what its verdict says it sells, as a real homepage does. */
function ownWords<P extends { json?: unknown; markdown?: string; bare?: boolean }>(page: P): P {
  const profile = page.json as CompanyProfile | null | undefined;
  const text = page.markdown ?? profile?.what_they_sell ?? "";
  return { ...page, markdown: page.bare ? text : text + FOOTER };
}

describe("grounded website search", () => {
  test("the query carries the description words, the city, and the sector, not the funding vocabulary", () => {
    expect(distinguishingWords(OLLIE)).toEqual(["San", "Diego", "AI", "assistant"]);
    expect(websiteQuery(OLLIE)).toBe("Ollie San Diego AI assistant");
    expect(websiteQuery({ company_name: "Ollie", company_description: null, headquarters: null, sector: null })).toBe(
      "Ollie official website",
    );
    expect(websiteQuery({ company_name: "Acme", company_description: "Acme builds widgets for factories.", sector: "other" })).toBe(
      "Acme builds widgets factories",
    );
  });

  test("the identity prompt names who we are looking for", () => {
    const prompt = identityPrompt(OLLIE);
    expect(prompt).toContain('"Ollie"');
    expect(prompt).toContain("San Diego-based AI assistant");
    expect(prompt).toContain("Headquarters: San Diego, USA.");
    expect(prompt).toContain("Sector: ai.");
    expect(prompt).toContain("same_company");
  });

  test("the identity prompt asks for a compatible line of business, not matching wording, and a named business behind every false", () => {
    const prompt = identityPrompt(ZENERGIZE);
    expect(prompt).toContain("compatible line of business");
    expect(prompt).toContain("more specifically or more generally");
    expect(prompt).toContain("Different wording is not a different company");
    expect(prompt).toContain("false only when the site is clearly a different business");
    expect(prompt).toContain("name that different business in different_business");
    expect(CompanyProfile.shape.same_company.description).toContain("compatible line of business");
    expect(CompanyProfile.shape.same_company.description).toContain("false only when the site is clearly a different business");
    expect(namesDifferentBusiness(DOG_FOOD)).toBe(true);
    expect(namesDifferentBusiness(WORDING_QUIBBLE)).toBe(false);
    expect(namesDifferentBusiness({ ...WORDING_QUIBBLE, different_business: null })).toBe(false);
    expect(namesDifferentBusiness({ ...WORDING_QUIBBLE, different_business: "  " })).toBe(false);
  });

  test("a record with no description grounds itself in the sentence it was read from and the headline", () => {
    const wonderful = {
      company_name: "Wonderful",
      company_description: null,
      headquarters: null,
      sector: null,
      evidence: "Israeli-Dutch AI startup Wonderful has raised $550 million in a Series C funding round.",
      headline: "Wonderful raises $550M Series C to scale the AI operating system for the enterprise",
    };
    expect(describedAs(wonderful)).toBe(wonderful.evidence);
    expect(websiteQuery(wonderful)).toBe("Wonderful Israeli-Dutch AI");
    const prompt = identityPrompt(wonderful);
    expect(prompt).toContain('The press reported it as: "Israeli-Dutch AI startup Wonderful');
    expect(prompt).toContain('Under the headline: "Wonderful raises $550M Series C');
    expect(hasContext(wonderful)).toBe(true);
    expect(hasContext({ company_name: "Wonderful", company_description: null, headquarters: null, sector: "other" })).toBe(false);
  });

  test("with nothing to verify against, no search is made: the row is none with a reason, and nothing is written", async () => {
    const { client, calls } = fakeClient(["https://wonderful.com"], {
      "wonderful.com": { json: { ...ASSISTANT, what_they_sell: "Pistachios" } },
    });
    const { enrichments } = await enrichCompanies(client, [{ company_key: "wonderful", company_name: "Wonderful", company_website: null }]);
    expect(calls.search).toEqual([]);
    expect(calls.scrape).toEqual([]);
    expect(enrichments[0].website_source).toBe("none");
    expect(enrichments[0].company_website).toBeNull();
    expect(enrichments[0].profile).toBeNull();
    expect(enrichments[0].error).toContain("no description, evidence, headline, city, or sector");
  });

  test("the enrichment records the context it checked against, and a profile verified against nothing reads as unverified", async () => {
    const { client } = fakeClient(["https://ollie.ai"], { "ollie.ai": { json: ASSISTANT } });
    const { enrichments } = await enrichCompanies(client, [OLLIE]);
    expect(enrichments[0].context).toEqual(["description", "headquarters", "sector"]);
    expect(profileUnverified(enrichments[0])).toBe(false);
    expect(profileUnverified({ ...enrichments[0], context: [] })).toBe(true);
    // Legacy rows without the field keep their verdict.
    const { context: _dropped, ...legacy } = enrichments[0];
    expect(profileUnverified(legacy)).toBe(false);
  });

  test("findWebsite searches the grounded query and returns up to three name-matching hosts in order", async () => {
    const { client, calls } = fakeClient(
      [
        "https://techcrunch.com/2026/09/04/ollie-raises",
        "https://www.linkedin.com/company/ollie",
        "https://www.ollie.com/",
        "https://ollie.ai/about",
        "https://heyollie.com/",
        "https://ollieapp.io/",
      ],
      {},
    );
    expect(await findWebsite(client, OLLIE)).toEqual(["https://ollie.com", "https://ollie.ai", "https://heyollie.com"]);
    expect(calls.search).toEqual(["Ollie San Diego AI assistant"]);
  });
});

describe("enrichCompanies identity verification", () => {
  test("the Ollie case: the first candidate is a namesake, the second verifies and is the one written", async () => {
    const { client, calls } = fakeClient(["https://www.ollie.com/", "https://ollie.ai/"], {
      "ollie.com": { json: DOG_FOOD, branding: { logo: "/dog-logo.png" }, metadata: { favicon: "/apple-touch-icon.png" } },
      "ollie.ai": { json: ASSISTANT, branding: { brandName: "Ollie", logo: "/logo.svg" }, links: ["https://ollie.ai/pricing"] },
    });
    const { enrichments, creditsEstimated } = await enrichCompanies(client, [OLLIE], { pricingPage: false });
    const [e] = enrichments;
    expect(calls.scrape).toEqual(["https://ollie.com", "https://ollie.ai"]);
    expect(e?.company_website).toBe("https://ollie.ai");
    expect(e?.website_source).toBe("search");
    expect(e?.profile?.what_they_sell).toContain("AI assistant");
    expect(e?.logo_url).toBe("https://ollie.ai/logo.svg");
    expect(e?.brand?.name).toBe("Ollie");
    expect(e?.pricing_page_url).toBe("https://ollie.ai/pricing");
    expect(e?.error).toBeUndefined();
    // One five-result search plus two homepage extractions: the rejected candidate is paid for too.
    const { enrichments: oneScrape, creditsEstimated: oneScrapeCredits } = await enrichCompanies(
      fakeClient(["https://ollie.ai/"], { "ollie.ai": { json: ASSISTANT } }).client,
      [OLLIE],
      { pricingPage: false },
    );
    expect(oneScrape[0]?.company_website).toBe("https://ollie.ai");
    expect(creditsEstimated).toBeGreaterThan(oneScrapeCredits);
  });

  test("no candidate verifies: unverified, nothing written, the error names every host tried", async () => {
    const { client, calls } = fakeClient(["https://www.ollie.com/", "https://ollie.pet/", "https://ollie.dog/", "https://ollie.ai/"], {
      "ollie.com": { json: DOG_FOOD },
      "ollie.pet": { json: { ...DOG_FOOD, identity_reason: "A pet insurer." } },
      "ollie.dog": { json: { ...DOG_FOOD, identity_reason: "A dog walking app." } },
      "ollie.ai": { json: ASSISTANT },
    });
    const { enrichments } = await enrichCompanies(client, [OLLIE], { pricingPage: false });
    const [e] = enrichments;
    // Three candidates at most; the fourth result is never read.
    expect(calls.scrape).toHaveLength(MAX_HOMEPAGE_SCRAPES);
    expect(e?.website_source).toBe("unverified");
    expect(e?.company_website).toBeNull();
    expect(e?.profile).toBeNull();
    expect(e?.logo_url).toBeNull();
    expect(e?.brand).toBeNull();
    expect(e?.error).toContain("ollie.com (The site sells human-grade dog food");
    expect(e?.error).toContain("ollie.pet (A pet insurer.)");
    expect(e?.error).toContain("ollie.dog (A dog walking app.)");
  });

  test("a record website that fails verification is a miss: the mismatch is recorded, nothing is written", async () => {
    const { client, calls } = fakeClient([], {
      "ollie.com": { json: DOG_FOOD, branding: { logo: "/dog-logo.png" } },
    });
    const { enrichments } = await enrichCompanies(client, [{ ...OLLIE, company_website: "https://www.ollie.com" }], {
      pricingPage: false,
    });
    const [e] = enrichments;
    expect(calls.scrape).toEqual(["https://www.ollie.com"]);
    // The grounded search still got its turn, then the name's own search, and neither found more to try.
    expect(calls.search).toEqual(["Ollie San Diego AI assistant", "Ollie official website"]);
    expect(e?.website_source).toBe("unverified");
    expect(e?.company_website).toBeNull();
    expect(e?.profile).toBeNull();
    expect(e?.logo_url).toBeNull();
    expect(e?.error).toContain("ollie.com (The site sells human-grade dog food");
  });

  test("a record website that verifies keeps its source and needs no search", async () => {
    const { client, calls } = fakeClient([], { "ollie.ai": { json: ASSISTANT, metadata: { favicon: "/favicon.ico" } } });
    const { enrichments } = await enrichCompanies(client, [{ ...OLLIE, company_website: "https://ollie.ai" }], { pricingPage: false });
    expect(calls.search).toHaveLength(0);
    expect(enrichments[0]?.website_source).toBe("record");
    expect(enrichments[0]?.company_website).toBe("https://ollie.ai");
    expect(enrichments[0]?.logo_url).toBe("https://ollie.ai/favicon.ico");
  });

  test("the OpenAI case: a news-only grounded search leaves the name's own search to find the homepage, still checked", async () => {
    const OPENAI = {
      company_key: "openai",
      company_name: "OpenAI",
      company_website: null,
      evidence: "OpenAI to raise $40 billion in SoftBank-led round to boost AI efforts",
      headquarters: "San Francisco, USA",
      sector: "ai",
    };
    const LAB: CompanyProfile = {
      same_company: true,
      identity_reason: "The site is OpenAI's, an AI research and deployment company, matching the record.",
      different_business: null,
      what_they_sell: "OpenAI builds AI models and products such as ChatGPT and an API for developers and businesses.",
      customer_type: "developer tool or API",
      sells_software_subscription: true,
    };
    const calls: string[] = [];
    const client = {
      async search(query: string) {
        calls.push(query);
        return query.endsWith("official website")
          ? { web: [{ url: "https://openai.com/" }, { url: "https://en.wikipedia.org/wiki/OpenAI" }] }
          : { web: [{ url: "https://www.reuters.com/technology/openai-raise-40-billion" }, { url: "https://techcrunch.com/openai" }] };
      },
      async scrape(url: string) {
        return { links: [], metadata: { title: "OpenAI" }, ...ownWords({ json: new URL(url).hostname === "openai.com" ? LAB : null }) };
      },
    } as unknown as Firecrawl;
    const { enrichments } = await enrichCompanies(client, [OPENAI], { pricingPage: false });
    expect(calls).toEqual(["OpenAI SoftBank-led boost AI efforts San Francisco", "OpenAI official website"]);
    expect(enrichments[0]?.company_website).toBe("https://openai.com");
    expect(enrichments[0]?.website_source).toBe("search");
    // The name's search finds a namesake just as easily: its homepage is refused like any other.
    const refused = await enrichCompanies(
      fakeClient(["https://www.ollie.com/"], { "ollie.com": { json: DOG_FOOD } }).client,
      [{ ...OLLIE, company_description: null, evidence: "Ollie raises $7.5m seed for its San Diego AI assistant" }],
      { pricingPage: false },
    );
    expect(refused.enrichments[0]?.website_source).toBe("unverified");
  });

  test("a search that finds nothing is still none", async () => {
    const { client } = fakeClient(["https://techcrunch.com/ollie"], {});
    const { enrichments } = await enrichCompanies(client, [OLLIE], { pricingPage: false });
    expect(enrichments[0]?.website_source).toBe("none");
    expect(enrichments[0]?.error).toBeUndefined();
  });
});

describe("a homepage the scrape could not read is unknown, not refused", () => {
  test("the Conveo case: the scrape throws, the record's website stays with no profile, the host is unreadable", async () => {
    const { client, calls } = fakeClient([], { "conveo.ai": new Error("Request timed out") });
    const { enrichments } = await enrichCompanies(client, [CONVEO], { pricingPage: false });
    const [e] = enrichments;
    expect(calls.scrape).toEqual(["https://www.conveo.ai"]);
    // The grounded search still got its turn, then the name's own search; neither offered anything else to read.
    expect(calls.search).toHaveLength(2);
    expect(e?.company_website).toBe("https://www.conveo.ai");
    expect(e?.website_source).toBe("record");
    expect(e?.profile).toBeNull();
    expect(e?.logo_url).toBeNull();
    expect(e?.unreadable_hosts).toEqual(["conveo.ai"]);
    expect(e?.refused_hosts).toEqual([]);
    expect(e?.error).toBe("conveo.ai (could not be read)");
    expect(isVerified(e as NonNullable<typeof e>)).toBe(false);
    expect(isPending(e as NonNullable<typeof e>)).toBe(true);
    expect(profileUnverified(e)).toBe(true);
  });

  test("a page that yields no JSON profile is unreadable too, and it does not count as parked", async () => {
    const { client } = fakeClient([], { "clearjet.com": { json: undefined, metadata: { title: "ClearJet" } } });
    const { enrichments } = await enrichCompanies(
      client,
      [{ ...CONVEO, company_key: "clearjet", company_name: "ClearJet", company_website: "https://clearjet.com" }],
      {
        pricingPage: false,
      },
    );
    const [e] = enrichments;
    expect(e?.company_website).toBe("https://clearjet.com");
    expect(e?.website_source).toBe("record");
    expect(e?.unreadable_hosts).toEqual(["clearjet.com"]);
    expect(e?.refused_hosts).toEqual([]);
    expect(e?.error).toBe("clearjet.com (could not be read)");
  });

  test("an unreadable search candidate is kept as the website from search; a refused namesake stays refused beside it", async () => {
    const { client } = fakeClient(["https://www.ollie.com/", "https://ollie.ai/"], {
      "ollie.com": { json: DOG_FOOD },
      "ollie.ai": new Error("blocked"),
    });
    const { enrichments } = await enrichCompanies(client, [OLLIE], { pricingPage: false });
    const [e] = enrichments;
    expect(e?.company_website).toBe("https://ollie.ai");
    expect(e?.website_source).toBe("search");
    expect(e?.profile).toBeNull();
    expect(e?.refused_hosts).toEqual(["ollie.com"]);
    expect(e?.unreadable_hosts).toEqual(["ollie.ai"]);
    expect(e?.error).toContain("no homepage verified as Ollie: ollie.com (The site sells human-grade dog food");
    expect(e?.error).toContain("ollie.ai (could not be read)");
  });

  test("with no context to search on, an unreadable record website is still kept and still says why", async () => {
    const { client, calls } = fakeClient(["https://conveo.ai"], { "conveo.ai": new Error("timeout") });
    const { enrichments } = await enrichCompanies(
      client,
      [{ company_key: "conveo", company_name: "Conveo", company_website: "https://conveo.ai" }],
      {
        pricingPage: false,
      },
    );
    expect(calls.search).toEqual([]);
    expect(enrichments[0]?.company_website).toBe("https://conveo.ai");
    expect(enrichments[0]?.website_source).toBe("record");
    expect(enrichments[0]?.unreadable_hosts).toEqual(["conveo.ai"]);
    expect(enrichments[0]?.error).toContain("conveo.ai (could not be read)");
    expect(enrichments[0]?.error).toContain("no description, evidence, headline, city, or sector");
  });

  test("a verified homepage still records the unreadable host it passed over", async () => {
    const { client } = fakeClient(["https://www.ollie.com/", "https://ollie.ai/"], {
      "ollie.com": new Error("blocked"),
      "ollie.ai": { json: ASSISTANT },
    });
    const { enrichments } = await enrichCompanies(client, [OLLIE], { pricingPage: false });
    expect(enrichments[0]?.company_website).toBe("https://ollie.ai");
    expect(enrichments[0]?.profile?.same_company).toBe(true);
    expect(enrichments[0]?.unreadable_hosts).toEqual(["ollie.com"]);
    expect(enrichments[0]?.refused_hosts).toEqual([]);
  });
});

describe("the benefit of the doubt for an exact-name host", () => {
  test("the Zenergize case: false over wording on the name host keeps the website with no profile, and refuses nothing", async () => {
    const { client } = fakeClient([], { "zenergize.in": { json: WORDING_QUIBBLE, branding: { logo: "/logo.png" } } });
    const { enrichments } = await enrichCompanies(client, [ZENERGIZE], { pricingPage: false });
    const [e] = enrichments;
    expect(e?.company_website).toBe("https://zenergize.in");
    expect(e?.website_source).toBe("record");
    expect(e?.profile).toBeNull();
    expect(e?.logo_url).toBeNull();
    expect(e?.refused_hosts).toEqual([]);
    expect(e?.unreadable_hosts).toEqual([]);
    expect(e?.error).toContain("kept without a verdict on the name host: zenergize.in (sells inverters and EV chargers");
    expect(isPending(e as NonNullable<typeof e>)).toBe(true);
    expect(profileUnverified(e)).toBe(true);
  });

  test("the Mantel case: a false that names a different business is refused as before", async () => {
    const { client } = fakeClient([], {
      "mantel.com": {
        json: {
          ...WORDING_QUIBBLE,
          identity_reason: "a bicycle retailer",
          different_business: "bicycle retail",
          what_they_sell: "Bicycles.",
        },
      },
    });
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          ...ZENERGIZE,
          company_key: "mantel",
          company_name: "Mantel",
          company_website: "https://www.mantel.com",
          company_description: "an AI agent for insurance claims",
        },
      ],
      { pricingPage: false },
    );
    const [e] = enrichments;
    expect(e?.company_website).toBeNull();
    expect(e?.website_source).toBe("unverified");
    expect(e?.refused_hosts).toEqual(["mantel.com"]);
    expect(e?.error).toContain("mantel.com (a bicycle retailer)");
  });

  test("the doubt is only for an exact-name host with a description behind it", async () => {
    // A host that does not carry the name gets no such latitude.
    const other = fakeClient([], { "zen-power.in": { json: WORDING_QUIBBLE } });
    const { enrichments: offName } = await enrichCompanies(other.client, [{ ...ZENERGIZE, company_website: "https://zen-power.in" }], {
      pricingPage: false,
    });
    expect(offName[0]?.company_website).toBeNull();
    expect(offName[0]?.refused_hosts).toEqual(["zen-power.in"]);
    // Nor does a record that never described the company: the model had only the name to judge on.
    const bare = fakeClient([], { "zenergize.in": { json: WORDING_QUIBBLE } });
    const { enrichments: noDescription } = await enrichCompanies(
      bare.client,
      [{ ...ZENERGIZE, company_description: null, evidence: "Zenergize raised $4 million." }],
      { pricingPage: false },
    );
    expect(noDescription[0]?.company_website).toBeNull();
    expect(noDescription[0]?.refused_hosts).toEqual(["zenergize.in"]);
  });

  test("a second candidate that verifies still wins over a doubted first", async () => {
    const { client } = fakeClient(["https://zenergize.com/"], {
      "zenergize.in": { json: WORDING_QUIBBLE },
      "zenergize.com": {
        json: { ...ASSISTANT, what_they_sell: "SiC inverters and EV chargers." },
        markdown: "SiC inverters and EV chargers, built on our silicon carbide power electronics.",
      },
    });
    const { enrichments } = await enrichCompanies(client, [ZENERGIZE], { pricingPage: false });
    expect(enrichments[0]?.company_website).toBe("https://zenergize.com");
    expect(enrichments[0]?.website_source).toBe("search");
    expect(enrichments[0]?.profile?.same_company).toBe(true);
    expect(enrichments[0]?.refused_hosts).toEqual([]);
  });
});

describe("enrichBatch writes only verified rows", () => {
  async function seed() {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Ollie",
          company_key: "ollie",
          company_description: OLLIE.company_description,
          headquarters: OLLIE.headquarters,
          sector: "ai",
          stage: "seed",
          stage_as_written: "seed",
        }),
      ],
      "seed",
      "run-1",
    );
    return db;
  }
  const ollieRow = {
    id: "ollie",
    name: "Ollie",
    website: null,
    description: OLLIE.company_description,
    hq: OLLIE.headquarters,
    sector: "ai",
  };

  test("a namesake first, the real company second: the company row gets the verified site, domain, and logo", async () => {
    const db = await seed();
    const { client } = fakeClient(["https://www.ollie.com/", "https://ollie.ai/"], {
      "ollie.com": { json: DOG_FOOD, branding: { logo: "/dog-logo.png" } },
      "ollie.ai": { json: ASSISTANT, branding: { logo: "/logo.svg" } },
    });
    const r = await enrichBatch(db, client, [ollieRow], { pricingPage: false });
    expect(r.resolved).toBe(1);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.website).toBe("https://ollie.ai");
    expect(company?.domain).toBe("ollie.ai");
    expect(company?.logoUrl).toBe("https://ollie.ai/logo.svg");
    // The record's own description wins over the profile's sentence.
    expect(company?.description).toBe(OLLIE.company_description);
  });

  test("a verified homepage's clean brand replaces a headline category descriptor", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Neocloud Nscale",
          company_key: "nscale",
          company_website: "https://nscale.com",
          company_domain: "nscale.com",
        }),
      ],
      "growth",
      "run-1",
    );
    const { client } = fakeClient([], {
      "nscale.com": {
        json: { ...ASSISTANT, what_they_sell: "Nscale operates AI infrastructure for enterprise customers." },
        branding: { brandName: "Nscale" },
      },
    });
    const result = await enrichBatch(
      db,
      client,
      [
        {
          id: "nscale.com",
          name: "Neocloud Nscale",
          website: "https://nscale.com",
          description: "an AI infrastructure company",
          hq: null,
          sector: "ai",
        },
      ],
      { pricingPage: false },
    );
    expect(result.resolved).toBe(1);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "nscale.com"));
    expect(company?.name).toBe("Nscale");
    expect(company?.nameKey).toBe("nscale");
    expect(company?.website).toBe("https://nscale.com");
  });

  test("the round's headline reaches the identity check as context", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Ollie",
          company_key: "ollie",
          stage: "seed",
          sources: [
            { url: "https://news.example/ollie", host: "news.example", title: "San Diego's Ollie raises $7.5M for its AI assistant" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    const { client } = fakeClient(["https://ollie.ai/"], { "ollie.ai": { json: ASSISTANT } });
    const r = await enrichBatch(db, client, [{ ...ollieRow, description: null, hq: null, sector: null }], { pricingPage: false });
    expect(r.enrichments[0]?.context).toContain("headline");
  });

  test("a round sourced from the company's own site offers that site first, before any search", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Ollie",
          company_key: "ollie",
          company_description: OLLIE.company_description,
          stage: "seed",
          sources: [
            { url: "https://news.example/ollie", host: "news.example", title: "Ollie raises $7.5M" },
            { url: "https://ollie.ai/blog/seed", host: "ollie.ai", title: "Our seed round" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    const { client, calls } = fakeClient([], { "ollie.ai": { json: ASSISTANT } });
    const r = await enrichBatch(db, client, [ollieRow], { pricingPage: false });
    expect(r.resolved).toBe(1);
    expect(calls.scrape).toEqual(["https://ollie.ai"]);
    expect(calls.search).toHaveLength(0);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.domain).toBe("ollie.ai");
  });

  test("nothing verifies: the enrichment row lands with the error, the company row is untouched", async () => {
    const db = await seed();
    const { client } = fakeClient(["https://www.ollie.com/"], { "ollie.com": { json: DOG_FOOD, branding: { logo: "/dog-logo.png" } } });
    const r = await enrichBatch(db, client, [ollieRow], { pricingPage: false });
    expect(r.resolved).toBe(0);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    const [row] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "ollie"));
    expect(row?.kind).toBe("profile");
    expect(row?.sourceUrl).toBeNull();
    const data = row?.data as { website_source: string; error: string } | undefined;
    expect(data?.website_source).toBe("unverified");
    expect(data?.error).toContain("ollie.com");
  });

  test("a website the record guessed is cleared from the company row once the check refuses that host", async () => {
    const db = await seed();
    // The extractor put the namesake's site on the record (Mantel the bicycle shop under Mantel the startup).
    await db
      .update(schema.companies)
      .set({ website: "https://www.ollie.com", domain: "ollie.com", logoUrl: "https://www.ollie.com/apple-touch-icon.png" })
      .where(eq(schema.companies.id, "ollie"));
    const { client } = fakeClient([], { "ollie.com": { json: DOG_FOOD } });
    await enrichBatch(db, client, [{ ...ollieRow, website: "https://www.ollie.com" }], { pricingPage: false });
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    const [row] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "ollie"));
    expect((row?.data as { refused_hosts: string[] } | undefined)?.refused_hosts).toEqual(["ollie.com"]);
  });

  test("the Creem case: a refused record website is replaced by the homepage that verified, and the namesake's Alexandria facts go", async () => {
    const db = await testDb();
    const description = "a billing and monetisation platform targeting AI-native software companies";
    await persistRecords(
      db,
      [
        record({
          company_name: "Creem",
          company_key: "creem",
          company_website: "https://www.creem.com/",
          company_domain: "creem.com",
          company_description: description,
          headquarters: "Tallinn, Estonia",
          sector: "fintech",
          stage: "seed",
          stage_as_written: "seed",
        }),
      ],
      "seed",
      "run-1",
    );
    // FullEnrich matched creem.com: CREEM, the rock magazine founded in 1969.
    await db.insert(schema.enrichments).values({
      companyId: "creem.com",
      kind: "alexandria",
      data: { domain: "creem.com", firmographics: { status: "matched", industry: "Entertainment Providers", year_founded: 1969 } },
    });
    const MAGAZINE: CompanyProfile = {
      same_company: false,
      identity_reason: "The site is a rock music magazine, not a billing platform.",
      different_business: "music magazine",
      what_they_sell: "CREEM is a print quarterly about rock music.",
      customer_type: "consumer",
      sells_software_subscription: false,
    };
    const BILLING: CompanyProfile = {
      same_company: true,
      identity_reason: "The site sells a billing and monetization platform for AI-native software companies.",
      different_business: null,
      what_they_sell: "Creem is a billing and monetization platform for AI-native software companies.",
      customer_type: "B2B software",
      sells_software_subscription: true,
    };
    const { client } = fakeClient(["https://creem.io/"], {
      "creem.com": { json: MAGAZINE, branding: { logo: "/creem-mag.png" } },
      "creem.io": { json: BILLING, branding: { logo: "/logo.svg" } },
    });
    const creemRow = {
      id: "creem.com",
      name: "Creem",
      website: "https://www.creem.com/",
      description,
      hq: "Tallinn, Estonia",
      sector: "fintech",
    };
    const r = await enrichBatch(db, client, [creemRow], { pricingPage: false });
    expect(r.resolved).toBe(1);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "creem.com"));
    expect(company?.domain).toBe("creem.io");
    expect(company?.website).toBe("https://creem.io");
    expect(company?.logoUrl).toBe("https://creem.io/logo.svg");
    const kinds = (await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "creem.com"))).map((e) => e.kind);
    expect(kinds).toEqual(["profile"]);
  });

  async function seedConveo() {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Conveo",
          company_key: "conveo",
          company_website: "https://www.conveo.ai",
          company_domain: "conveo.ai",
          company_description: CONVEO.company_description,
          headquarters: CONVEO.headquarters,
          sector: "ai",
          stage: "seed",
          stage_as_written: "seed",
        }),
      ],
      "seed",
      "run-1",
    );
    return db;
  }
  // A record that names a domain gets the domain as its company id.
  const conveoRow = {
    id: "conveo.ai",
    name: "Conveo",
    website: "https://www.conveo.ai",
    description: CONVEO.company_description,
    hq: CONVEO.headquarters,
    sector: "ai",
  };

  test("the Conveo case: an unreadable record website stays only in retry evidence, never the public row", async () => {
    const db = await seedConveo();
    const { client } = fakeClient([], { "conveo.ai": new Error("Request timed out") });
    const r = await enrichBatch(db, client, [conveoRow], { pricingPage: false });
    expect(r.resolved).toBe(0);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "conveo.ai"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    expect(company?.description).toBe(CONVEO.company_description);
    const [row] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "conveo.ai"));
    const data = row?.data as {
      unreadable_hosts: string[];
      refused_hosts: string[];
      error: string;
      profile: unknown;
      website_source: string;
    };
    expect(data.unreadable_hosts).toEqual(["conveo.ai"]);
    expect(data.refused_hosts).toEqual([]);
    expect(data.error).toContain("could not be read");
    expect(data.profile).toBeNull();
    expect(data.website_source).toBe("record");
    expect(row?.sourceUrl).toBe("https://www.conveo.ai");
    // The next enrich lane gets another go; the candidate is retained only in the prior record or read evidence.
    expect(await clearUnverifiedProfiles(db)).toEqual({ cleared: 1 });
    expect(await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "conveo.ai"))).toHaveLength(0);
    const [after] = await db.select().from(schema.companies).where(eq(schema.companies.id, "conveo.ai"));
    expect(after?.website).toBeNull();
    expect(after?.domain).toBeNull();
  });

  test("an unreadable search candidate never lands a public website or domain", async () => {
    const db = await seed();
    const { client } = fakeClient(["https://ollie.ai/"], { "ollie.ai": new Error("blocked") });
    const r = await enrichBatch(db, client, [ollieRow], { pricingPage: false });
    expect(r.resolved).toBe(0);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    // The domain is not written when another row owns it: an unverified site never folds companies.
    const db2 = await seed();
    await db2.insert(schema.companies).values({ id: "other-ollie", name: "Other Ollie", nameKey: "other ollie", domain: "ollie.ai" });
    await enrichBatch(db2, client, [ollieRow], { pricingPage: false });
    const [second] = await db2.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(second?.website).toBeNull();
    expect(second?.domain).toBeNull();
    expect((await db2.select().from(schema.companies).where(eq(schema.companies.id, "other-ollie"))).length).toBe(1);
  });

  test("the Zenergize case: a doubted name host stays pending without a public website or domain", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Zenergize Technologies",
          company_key: "zenergize-technologies",
          company_website: "https://zenergize.in",
          company_domain: "zenergize.in",
          company_description: ZENERGIZE.company_description,
          stage: "seed",
          stage_as_written: "Pre-Series A",
        }),
      ],
      "seed",
      "run-1",
    );
    const { client } = fakeClient([], { "zenergize.in": { json: WORDING_QUIBBLE, branding: { logo: "/logo.png" } } });
    const r = await enrichBatch(
      db,
      client,
      [
        {
          id: "zenergize.in",
          name: "Zenergize Technologies",
          website: "https://zenergize.in",
          description: ZENERGIZE.company_description,
          hq: null,
          sector: null,
        },
      ],
      { pricingPage: false },
    );
    expect(r.resolved).toBe(0);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "zenergize.in"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    expect(company?.description).toBe(ZENERGIZE.company_description);
    const [row] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "zenergize.in"));
    const data = row?.data as { refused_hosts: string[]; profile: unknown } | undefined;
    expect(data?.refused_hosts).toEqual([]);
    expect(data?.profile).toBeNull();
    expect(await clearUnverifiedProfiles(db)).toEqual({ cleared: 1 });
  });

  test("clearProfile forgets what an ungrounded search wrote; reverify clears only the profiles the check never saw", async () => {
    const db = await seed();
    // The old shape: a profile from "search" with no same_company, and the dog food on the company row.
    const legacy = {
      company_key: "ollie",
      company_website: "https://ollie.com",
      website_source: "search",
      logo_url: "https://www.ollie.com/apple-touch-icon.png",
      profile: { what_they_sell: DOG_FOOD.what_they_sell, customer_type: "consumer", sells_software_subscription: false },
    };
    await db.insert(schema.enrichments).values({ companyId: "ollie", kind: "profile", data: legacy, sourceUrl: legacy.company_website });
    await db
      .update(schema.companies)
      .set({ website: "https://ollie.com", domain: "ollie.com", logoUrl: legacy.logo_url, description: DOG_FOOD.what_they_sell })
      .where(eq(schema.companies.id, "ollie"));
    expect(profileUnverified(legacy)).toBe(true);
    expect(profileUnverified({ ...legacy, profile: { ...legacy.profile, same_company: true } })).toBe(false);
    expect(profileUnverified({ company_key: "x", company_website: null, website_source: "none" })).toBe(false);

    expect(await clearUnverifiedProfiles(db)).toEqual({ cleared: 1 });
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(company?.website).toBeNull();
    expect(company?.domain).toBeNull();
    expect(company?.logoUrl).toBeNull();
    expect(company?.description).toBeNull();
    expect(await db.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "ollie"))).toHaveLength(0);
    expect(await clearProfile(db, "ollie")).toEqual({ cleared: false });

    // A website the record itself named survives a clear; only the logo and the profile go.
    const fromRecord = { ...legacy, website_source: "record", profile: { ...legacy.profile, same_company: false } };
    await db.insert(schema.enrichments).values({ companyId: "ollie", kind: "profile", data: fromRecord });
    await db
      .update(schema.companies)
      .set({ website: "https://ollie.com", logoUrl: "https://ollie.com/x.png" })
      .where(eq(schema.companies.id, "ollie"));
    expect(await clearProfile(db, "ollie")).toEqual({ cleared: true });
    const [again] = await db.select().from(schema.companies).where(eq(schema.companies.id, "ollie"));
    expect(again?.website).toBe("https://ollie.com");
    expect(again?.logoUrl).toBeNull();
  });
});
