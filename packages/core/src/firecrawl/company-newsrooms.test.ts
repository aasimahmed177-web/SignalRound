import { describe, expect, test } from "vitest";
import {
  type CompanyNewsroomTarget,
  discoverNewsrooms,
  discoveryDue,
  newsroomFundingLinks,
  newsroomSections,
  sectionDue,
} from "./company-newsrooms.ts";

describe("company newsroom discovery", () => {
  test("keeps sections on verified site and linked siblings, not unlinked lookalikes", () => {
    const sections = newsroomSections(
      [
        { url: "https://acme.com/press/announces-series-a" },
        { url: "https://acme.substack.com/p/funding-news" },
        { url: "https://acme.dev/blog/post" },
        { url: "https://acme-news.com/blog" },
        { url: "https://acme.com/products/scraper/api/google/news" },
        { url: "https://careers.acme.com/blog" },
        { url: "https://other.com/news" },
      ],
      { domain: "acme.com", aliases: ["acme.substack.com", "acme.dev"] },
    );
    expect(sections).toEqual(["https://acme.com/press", "https://acme.substack.com", "https://acme.dev/blog"]);
  });

  test("a homepage link permits discovering and mapping its sibling publication", async () => {
    const mapped: string[] = [];
    const client = {
      scrape: async () => ({ links: ["https://acme.substack.com/p/funding-news"] }),
      map: async (url: string) => {
        mapped.push(url);
        return { links: [{ url: "https://acme.substack.com/p/funding-news" }] };
      },
    };
    const result = await discoverNewsrooms(client as never, "https://acme.com", []);
    expect(result.linked).toEqual(["acme.substack.com"]);
    expect(result.sections).toContain("https://acme.substack.com");
    expect(mapped).toContain("https://acme.substack.com");
  });

  test("only funding-like articles inside the freshness window are offered to extraction", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(
      newsroomFundingLinks(
        [
          { url: "https://acme.com/press/2026/09/25/acme-raises-series-a" },
          { url: "https://acme.com/press/round-one", title: "Acme raises $30 million" },
          { url: "https://acme.com/press/2025/08/01/acme-raises-series-a" },
          { url: "https://acme.com/press/new-ceo-named" },
          { url: "https://other.com/press/acme-raises-series-b" },
          { url: "https://acme.com/press/", title: "Funding news" },
        ],
        "https://acme.com/press/",
        now,
      ),
    ).toEqual(["https://acme.com/press/2026/09/25/acme-raises-series-a", "https://acme.com/press/round-one"]);
  });

  test("checks prominent sources weekly, long tail monthly, and drains monitored sections weekly", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    const section = { url: "https://acme.com/news", monitorId: null, checkedAt: new Date("2026-09-15T12:00:00Z") };
    const target: CompanyNewsroomTarget = {
      id: "acme",
      name: "Acme",
      homepage: "https://acme.com",
      domain: "acme.com",
      aliases: [],
      top: true,
      monitor: false,
      lastRound: null,
      discoveredAt: new Date("2026-08-20T12:00:00Z"),
      sections: [section],
    };
    expect(sectionDue(target, section, now)).toBe(true);
    expect(discoveryDue(target, now)).toBe(true);
    expect(sectionDue({ ...target, top: false }, section, now)).toBe(false);
    expect(sectionDue({ ...target, top: false, lastRound: "2026-09-20" }, section, now)).toBe(true);
    expect(sectionDue({ ...target, top: false }, { ...section, monitorId: "monitor-1" }, now)).toBe(true);
  });
});
