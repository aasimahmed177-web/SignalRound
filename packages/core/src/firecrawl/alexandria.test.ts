// Alexandria calls are keyed on the company's verified domain: the YC search hit counts only
// when its website resolves to it, and a provider whose terms are not accepted is a typed
// outcome, not a crash.

import { describe, expect, test, vi } from "vitest";
import type { NativeWebClient as Firecrawl } from "../web/client.ts";
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
  test("reads only public YC company search hits and records zero scraping credits", async () => {
    const profile = { ...COMPANY_RECORD, name: SEARCH_RECORD.name };
    const scrape = vi.fn(async (_url: string) => ({ json: profile }));
    const search = vi.fn(async () => ({
      web: [
        { url: SEARCH_RECORD.url },
        { url: SEARCH_RECORD.url },
        { url: "https://ycombinator.com.evil.example/companies/firecrawl" },
        { url: "https://www.ycombinator.com/companies" },
      ],
    }));
    const r = await alexandriaCall({ scrape, search } as unknown as Firecrawl, {
      provider: "ycombinator-com",
      capability: "companies/search",
      options: { query: "Firecrawl" },
    });
    expect(r).toMatchObject({ ok: true, records: [{ name: "Firecrawl", slug: "firecrawl", url: SEARCH_RECORD.url }], credits: 0 });
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape.mock.calls[0]?.[0]).toBe(SEARCH_RECORD.url);
    expect(search).toHaveBeenCalledWith("site:ycombinator.com/companies Firecrawl", { limit: 4 });
  });

  test("search failures remain explicit provider errors", async () => {
    const client = {
      search: async () => {
        throw new Error("Search unavailable");
      },
    } as unknown as Firecrawl;
    const r = await alexandriaCall(client, { provider: "ycombinator-com", capability: "companies/search" });
    expect(r).toEqual({ ok: false, kind: "error", message: "Search unavailable" });
  });

  test("unsupported hosted providers are refused before any network request", async () => {
    const scrape = vi.fn();
    const r = await alexandriaCall({ scrape } as unknown as Firecrawl, { provider: "example", capability: "companies/lookup" });
    expect(r).toMatchObject({ ok: false, kind: "error", message: expect.stringContaining("Only the public YC directory") });
    expect(scrape).not.toHaveBeenCalled();
  });

  test("invalid company slugs and invalid structured profiles never produce records", async () => {
    const scrape = vi.fn(async () => ({ json: { name: "Unvalidated data" } }));
    const client = { scrape } as unknown as Firecrawl;
    expect(
      await alexandriaCall(client, { provider: "ycombinator-com", capability: "companies/company", options: { slug: "../private" } }),
    ).toMatchObject({ ok: false, message: "Invalid YC company slug" });
    expect(scrape).not.toHaveBeenCalled();
    expect(
      await alexandriaCall(client, { provider: "ycombinator-com", capability: "companies/company", options: { slug: "firecrawl" } }),
    ).toEqual({ ok: true, records: [], credits: 0 });
  });
});
