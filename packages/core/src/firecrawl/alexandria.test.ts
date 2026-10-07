// Alexandria calls are keyed on the company's verified domain: the YC search hit counts only
// when its website resolves to it, and a provider whose terms are not accepted is a typed
// outcome, not a crash.

import type { Firecrawl } from "firecrawl";
import { SdkError } from "firecrawl";
import { describe, expect, test } from "vitest";
import { alexandriaCall, pickYcHit, ycFromRecord } from "./alexandria.ts";

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
          "An organization admin must accept the example provider's terms. Accept them at https://www.firecrawl.dev/app/alexandria/example",
          403,
          "THIRD_PARTY_DATA_TERMS_REQUIRED",
          undefined,
          undefined,
          undefined,
          { type: "accept_terms", terms: "example", url: "https://www.firecrawl.dev/app/alexandria/example" },
        );
      },
    } as unknown as Firecrawl;
    const r = await alexandriaCall(client, { provider: "example", capability: "companies/lookup" });
    expect(r).toEqual({ ok: false, kind: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/example" });
  });

  test("a terms error without requiresAction still parses the url out of the message", async () => {
    const client = {
      scrape: async () => {
        throw new SdkError("Accept them at https://www.firecrawl.dev/app/alexandria/example", 403, "THIRD_PARTY_DATA_TERMS_REQUIRED");
      },
    } as unknown as Firecrawl;
    const r = await alexandriaCall(client, { provider: "example", capability: "companies/lookup" });
    expect(r).toEqual({ ok: false, kind: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/example" });
  });
});
