// Alexandria calls are keyed on the company's verified domain: the YC search hit counts only
// when its website resolves to it, and a provider whose terms are not accepted is a typed
// outcome, not a crash.

import { readFileSync } from "node:fs";
import type { Firecrawl } from "firecrawl";
import { SdkError } from "firecrawl";
import { describe, expect, test } from "vitest";
import {
  APOLLO_SCHEMA_VERSION,
  alexandriaCall,
  apolloBulk,
  apolloFromRecord,
  apolloNameMatches,
  firmographicsFromRecord,
  pickYcHit,
  validLinkedinCompanyUrl,
  ycFromRecord,
} from "./alexandria.ts";

const SEARCH_RECORD = {
  name: "Firecrawl",
  slug: "firecrawl",
  website: "https://www.firecrawl.dev",
  url: "https://www.ycombinator.com/companies/firecrawl",
  batch: "Summer 2022",
  one_liner: "The web data API for searching and scraping.",
  team_size: 3,
  status: "Active",
  tags: ["Artificial Intelligence", "Developer Tools", "Open Source"],
};

const COMPANY_RECORD = {
  slug: "firecrawl",
  batch_name: "Summer 2022",
  year_founded: 2024,
  team_size: 3,
  location: "San Francisco",
  one_liner: "The web data API for searching and scraping.",
  tags: ["Artificial Intelligence", "Developer Tools", "Open Source"],
  website: "https://www.firecrawl.dev",
  ycdc_status: "Active",
  founders: [
    {
      name: "Caleb Peffer",
      title: "Founder/CEO",
      bio: "CEO at Firecrawl",
      linkedin_url: "https://www.linkedin.com/in/caleb-peffer/",
      twitter_url: null,
      active: true,
    },
    {
      name: "Eric Ciarla",
      title: "Founder",
      bio: "Cofounder @ Firecrawl",
      linkedin_url: "https://www.linkedin.com/in/eric-ciarla/",
      twitter_url: "https://x.com/ericciarla",
      active: true,
    },
    {
      name: "Nicolas Silberstein Camara",
      title: "Founder",
      bio: "Founder and CTO @ Firecrawl",
      linkedin_url: "https://www.linkedin.com/in/nicolas-silberstein-camara/",
      twitter_url: "https://twitter.com/nickscamara_",
      active: true,
    },
    { name: "Gone Founder", title: "Founder", bio: "left", linkedin_url: null, twitter_url: null, active: false },
  ],
};

function stubClient(result: unknown): Firecrawl {
  return { scrape: async () => result } as unknown as Firecrawl;
}

const okResult = (records: unknown[], creditsCost = 5, key = "records") => ({
  scrapeId: "s1",
  requestId: "r1",
  creditsCost,
  alexandria: [{ provider: "ycombinator-com", capability: "companies/search", creditsCost, data: { [key]: records } }],
});

describe("pickYcHit", () => {
  test("picks the hit whose website resolves to the verified domain, never a same-name namesake", () => {
    const records = [{ ...SEARCH_RECORD, name: "Firecrawl", website: "https://firecrawl-namesake.io", slug: "namesake" }, SEARCH_RECORD];
    expect(pickYcHit(records, "firecrawl.dev")?.slug).toBe("firecrawl");
    expect(pickYcHit(records, "other.dev")).toBeNull();
    expect(pickYcHit([], "firecrawl.dev")).toBeNull();
  });
});

describe("ycFromRecord", () => {
  test("the company record fills the search hit's shape; founders keep links and drop bios and the inactive", () => {
    const yc = ycFromRecord(SEARCH_RECORD, COMPANY_RECORD);
    expect(yc.slug).toBe("firecrawl");
    expect(yc.batch).toBe("Summer 2022");
    expect(yc.year_founded).toBe(2024);
    expect(yc.founders).toHaveLength(3);
    expect(yc.founders[0]).toEqual({
      name: "Caleb Peffer",
      title: "Founder/CEO",
      linkedin_url: "https://www.linkedin.com/in/caleb-peffer/",
      twitter_url: null,
    });
    expect(yc.founders.every((f) => !("bio" in f))).toBe(true);
  });
});

describe("firmographicsFromRecord", () => {
  test("Agave's captured FullEnrich record: the typed scalars plus industry, hq, and the LinkedIn url", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../../tests/fixtures/alexandria/fullenrich-agave.json", import.meta.url), "utf8"),
    );
    const f = firmographicsFromRecord(fixture.data.alexandria[0].data.companies[0]);
    expect(f.headcount).toBe(85);
    expect(f.headcount_range).toBe("11-50");
    expect(f.year_founded).toBe(2021);
    expect(f.company_type).toBe("Privately Held");
    expect(f.industry).toBe("Software Development");
    expect(f.hq).toBe("San Francisco, California");
    expect(f.linkedin_url).toBe("https://www.linkedin.com/company/agave-api");
    expect(f.logo_url).toBe("https://app.fullenrich.com/logo/company/handle/agave-api");
    expect(f.specialties).toHaveLength(7);
  });

  test("a zero year or headcount is the provider's unknown, not a fact", () => {
    const f = firmographicsFromRecord({ year_founded: 0, headcount: 0, headcount_range: "11-50" });
    expect(f.year_founded).toBeNull();
    expect(f.headcount).toBeNull();
    expect(f.headcount_range).toBe("11-50");
  });
});

describe("alexandriaCall", () => {
  test("a success returns the records and what the call cost", async () => {
    const r = await alexandriaCall(stubClient(okResult([SEARCH_RECORD])), { provider: "ycombinator-com", capability: "companies/search" });
    expect(r).toEqual({ ok: true, records: [SEARCH_RECORD], credits: 5 });
  });

  test("a per-call error is a typed error, not a throw", async () => {
    const result = {
      scrapeId: "s1",
      requestId: "r1",
      creditsCost: 0,
      alexandria: [
        {
          provider: "ycombinator-com",
          capability: "companies/search",
          error: { code: "invalid_option", message: "companies/search does not take limit.", status: 400 },
        },
      ],
    };
    const r = await alexandriaCall(stubClient(result), { provider: "ycombinator-com", capability: "companies/search" });
    expect(r).toEqual({ ok: false, kind: "error", message: "companies/search does not take limit." });
  });

  test("a thrown terms error is the terms_required outcome with the page to visit", async () => {
    const client = {
      scrape: async () => {
        throw new SdkError(
          "An organization admin must accept the fullenrich provider's terms. Accept them at https://www.firecrawl.dev/app/alexandria/fullenrich",
          403,
          "THIRD_PARTY_DATA_TERMS_REQUIRED",
          undefined,
          undefined,
          undefined,
          { type: "accept_terms", terms: "fullenrich", url: "https://www.firecrawl.dev/app/alexandria/fullenrich" },
        );
      },
    } as unknown as Firecrawl;
    const r = await alexandriaCall(client, { provider: "fullenrich", capability: "companies/lookup" });
    expect(r).toEqual({ ok: false, kind: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/fullenrich" });
  });

  test("a terms error without requiresAction still parses the url out of the message", async () => {
    const client = {
      scrape: async () => {
        throw new SdkError("Accept them at https://www.firecrawl.dev/app/alexandria/fullenrich", 403, "THIRD_PARTY_DATA_TERMS_REQUIRED");
      },
    } as unknown as Firecrawl;
    const r = await alexandriaCall(client, { provider: "fullenrich", capability: "companies/lookup" });
    expect(r).toEqual({ ok: false, kind: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/fullenrich" });
  });
});

// Apollo: the bulk answer captured from the live API (trimmed of anything about people), one entry
// per domain asked, null for a miss. cognition.com is filed under a four-person "CoDev Labs".
const apolloFixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/alexandria/apollo-bulk.json", import.meta.url), "utf8"));
const apolloOrgs: Array<Record<string, unknown> | null> = apolloFixture.data.alexandria[0].data.organizations;
const apolloOrg = (domain: string) => apolloOrgs.find((o) => o?.primary_domain === domain) ?? null;

describe("apolloFromRecord", () => {
  test("a domain match under another name is a namesake and keeps nothing it claimed but the name", () => {
    const r = apolloFromRecord(apolloOrg("cognition.com"), { name: "Cognition", domain: "cognition.com" });
    expect(r).toEqual({ status: "namesake", name: "CoDev Labs", domain: "cognition.com" });
  });

  test("another domain is a namesake even under the same name", () => {
    const r = apolloFromRecord(apolloOrg("vals.ai"), { name: "Vals", domain: "vals.com" });
    expect(r.status).toBe("namesake");
  });

  test("a miss is none", () => {
    expect(apolloFromRecord(null, { name: "Upwind", domain: "upwindsecurity.com" })).toEqual({ status: "none" });
  });

  test("a match is trimmed: no technologies, no keywords, events by month with the figure as written", () => {
    const r = apolloFromRecord(apolloOrg("anthropic.com"), { name: "Anthropic", domain: "anthropic.com" });
    if (r.status !== "matched") throw new Error("expected a match");
    expect(Object.keys(r).sort()).toEqual(
      [
        "apollo_id",
        "country",
        "domain",
        "founded_year",
        "funding_events",
        "headcount",
        "hq",
        "linkedin_url",
        "logo_url",
        "name",
        "status",
        "total_funding_usd",
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toContain("Bugzilla");
    expect(r.linkedin_url).toBe("https://www.linkedin.com/company/anthropicresearch");
    expect(r.headcount).toBe(6000);
    expect(r.hq).toBe("Cambridge, Massachusetts");
    expect(r.funding_events.find((e) => e.type === "Series A")).toEqual({
      date: "2021-05",
      type: "Series A",
      amount: "$124M",
      source_url: "https://www.finsmes.com/2021/05/anthropic-raises-124m-in-series-a-funding.html",
    });
  });
});

describe("apolloNameMatches", () => {
  test("legal and generic tails come off; another company's name does not match", () => {
    expect(apolloNameMatches("Vals AI", "Vals")).toBe(true);
    expect(apolloNameMatches("DIALYBRID", "Dialybrid S.r.l.")).toBe(true);
    expect(apolloNameMatches("G5 Labs.ai", "G5 Labs")).toBe(true);
    expect(apolloNameMatches("CarbonSix", "Carbon Six")).toBe(true);
    expect(apolloNameMatches("CoDev Labs", "Cognition")).toBe(false);
    expect(apolloNameMatches(null, "Cognition")).toBe(false);
  });
});

describe("validLinkedinCompanyUrl", () => {
  const clay = { name: "Clay", domain: "clay.com" };
  test("a company page whose slug names the company, canonicalized", () => {
    expect(validLinkedinCompanyUrl("http://www.linkedin.com/company/grow-with-clay", clay)).toBe(
      "https://www.linkedin.com/company/grow-with-clay",
    );
    expect(validLinkedinCompanyUrl("linkedin.com/company/tryprofound/", { name: "Profound", domain: "tryprofound.com" })).toBe(
      "https://www.linkedin.com/company/tryprofound",
    );
    expect(
      validLinkedinCompanyUrl("https://uk.linkedin.com/company/dialybridsrl", { name: "Dialybrid S.r.l.", domain: "dialybrid.com" }),
    ).toBe("https://www.linkedin.com/company/dialybridsrl");
  });
  test("another company's slug, a person, a post, or another host is refused", () => {
    expect(
      validLinkedinCompanyUrl("http://www.linkedin.com/company/co-dev-labs", { name: "Cognition", domain: "cognition.com" }),
    ).toBeNull();
    expect(validLinkedinCompanyUrl("https://www.linkedin.com/in/someone-at-clay", clay)).toBeNull();
    expect(validLinkedinCompanyUrl("https://www.linkedin.com/company/clay/posts/123", clay)).toBeNull();
    expect(validLinkedinCompanyUrl("https://notlinkedin.com/company/clay", clay)).toBeNull();
    expect(validLinkedinCompanyUrl(null, clay)).toBeNull();
  });
});

describe("apolloBulk", () => {
  /** A client that answers each call from the fixture, one entry per domain asked, and records the calls. */
  function bulkClient(opts: { fail?: boolean; unordered?: boolean } = {}) {
    const calls: string[][] = [];
    const client = {
      scrape: async (req: { alexandria: { provider: string; capability: string; options: Record<string, string[]> } }) => {
        const domains = req.alexandria.options["domains[]"];
        calls.push(domains);
        if (opts.fail) return { alexandria: [{ error: { code: "PROVIDER_ERROR", message: "upstream timeout" } }], creditsCost: 0 };
        let organizations = domains.map((d) => apolloOrg(d));
        if (opts.unordered) organizations = organizations.filter(Boolean).reverse();
        const matched = organizations.filter(Boolean).length;
        return { alexandria: [{ creditsCost: matched * 30, data: { organizations } }], creditsCost: matched * 30 };
      },
    } as unknown as Firecrawl;
    return { client, calls };
  }
  const company = (domain: string, name = domain.split(".")[0]) => ({ company_key: domain, company_name: name, domain });

  test("ten domains a call, one entry per company, credits only on what Apollo matched", async () => {
    const list = [
      company("anthropic.com", "Anthropic"),
      company("vals.ai", "Vals"),
      company("cognition.com", "Cognition"),
      ...Array.from({ length: 20 }, (_, i) => company(`nobody${i}.example`)),
    ];
    const { client, calls } = bulkClient();
    const out = await apolloBulk(client, list);
    expect(calls.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(out).toHaveLength(23);
    expect(out.map((e) => e.apollo.status).slice(0, 4)).toEqual(["matched", "matched", "namesake", "none"]);
    // The namesake is billed like any match; a miss is free.
    expect(out.slice(0, 4).map((e) => e.credits)).toEqual([30, 30, 30, 0]);
    expect(out.every((e) => e.schema_version === APOLLO_SCHEMA_VERSION)).toBe(true);
  });

  test("an answer shorter than the ask is placed by each record's own domain", async () => {
    const { client } = bulkClient({ unordered: true });
    const out = await apolloBulk(client, [
      company("upwindsecurity.com", "Upwind"),
      company("vals.ai", "Vals"),
      company("loora.com", "Loora"),
    ]);
    expect(out.map((e) => [e.domain, e.apollo.status])).toEqual([
      ["upwindsecurity.com", "none"],
      ["vals.ai", "matched"],
      ["loora.com", "matched"],
    ]);
  });

  test("a failed call marks its companies error and costs nothing", async () => {
    const { client } = bulkClient({ fail: true });
    const out = await apolloBulk(client, [company("vals.ai", "Vals")]);
    expect(out[0]).toMatchObject({ credits: 0, apollo: { status: "error", message: "upstream timeout" } });
  });
});
