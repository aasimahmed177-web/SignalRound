// The house company: which record is Fireround's own engine, and when its round is fresh enough to feature.

import { describe, expect, test } from "vitest";
import {
  DEFAULT_HOUSE_DOMAIN,
  HOUSE_FRESH_DAYS,
  houseDomain,
  houseFreshSince,
  houseHeadline,
  isFreshHouseRound,
  isHouseCompany,
  withArticle,
} from "../lib/house";

const NOW = new Date("2026-09-22T15:00:00Z");
const firecrawl = { id: "firecrawl.dev", domain: "firecrawl.dev" };

describe("houseDomain", () => {
  test("defaults to firecrawl.dev when unset or blank", () => {
    expect(houseDomain(undefined)).toBe(DEFAULT_HOUSE_DOMAIN);
    expect(houseDomain("  ")).toBe("firecrawl.dev");
  });

  test("an override is normalised to a bare domain", () => {
    expect(houseDomain("https://www.Example.com/about")).toBe("example.com");
  });

  test("off turns the treatment off", () => {
    for (const v of ["off", "OFF", "none", "false", "0"]) expect(houseDomain(v)).toBeNull();
  });
});

describe("isHouseCompany", () => {
  test("matches by domain or by a domain-shaped id", () => {
    expect(isHouseCompany(firecrawl, "firecrawl.dev")).toBe(true);
    expect(isHouseCompany({ id: "c_123", domain: "www.firecrawl.dev" }, "firecrawl.dev")).toBe(true);
    expect(isHouseCompany({ id: "firecrawl.dev", domain: null }, "firecrawl.dev")).toBe(true);
  });

  test("another company, a missing record, or the treatment off is not the house", () => {
    expect(isHouseCompany({ id: "zeliq.com", domain: "zeliq.com" }, "firecrawl.dev")).toBe(false);
    expect(isHouseCompany({ id: "firecrawl.com", domain: "firecrawl.com" }, "firecrawl.dev")).toBe(false);
    expect(isHouseCompany(null, "firecrawl.dev")).toBe(false);
    expect(isHouseCompany(firecrawl, null)).toBe(false);
  });

  test("follows the override", () => {
    expect(isHouseCompany(firecrawl, "example.com")).toBe(false);
    expect(isHouseCompany({ domain: "example.com" }, "example.com")).toBe(true);
  });
});

describe("isFreshHouseRound", () => {
  const round = (announced_on: string | null, company = firecrawl) => ({ company, announced_on });

  test("fresh from the day it is announced through the window", () => {
    expect(isFreshHouseRound(round("2026-09-22"), NOW, "firecrawl.dev")).toBe(true);
    expect(isFreshHouseRound(round("2026-09-15"), NOW, "firecrawl.dev")).toBe(true);
    expect(HOUSE_FRESH_DAYS).toBe(7);
  });

  test("stale past the window, undated, or dated well ahead", () => {
    expect(isFreshHouseRound(round("2026-09-14"), NOW, "firecrawl.dev")).toBe(false);
    expect(isFreshHouseRound(round(null), NOW, "firecrawl.dev")).toBe(false);
    expect(isFreshHouseRound(round("2026-09-25"), NOW, "firecrawl.dev")).toBe(false);
  });

  test("a publisher a day ahead of UTC still counts", () => {
    expect(isFreshHouseRound(round("2026-09-23"), NOW, "firecrawl.dev")).toBe(true);
  });

  test("another company's fresh round is not featured", () => {
    expect(isFreshHouseRound(round("2026-09-22", { id: "zeliq.com", domain: "zeliq.com" }), NOW, "firecrawl.dev")).toBe(false);
    expect(isFreshHouseRound(round("2026-09-22"), NOW, null)).toBe(false);
  });
});

describe("houseHeadline", () => {
  test("the figure sits apart so it can set in mono", () => {
    expect(houseHeadline({ name: "Firecrawl", amount: "$75M", stage: "Series B", leads: ["Smash Capital"] })).toEqual({
      lead: "Firecrawl raised a ",
      figure: "$75M",
      rest: " Series B",
      by: ", led by Smash Capital",
    });
  });

  test("the article follows the spoken figure", () => {
    expect(withArticle("$8M")).toBe("an $8M");
    expect(withArticle("$11.5M")).toBe("an $11.5M");
    expect(withArticle("$18M")).toBe("an $18M");
    expect(withArticle("$800M")).toBe("an $800M");
    expect(withArticle("$110M")).toBe("a $110M");
    expect(withArticle("$1.2B")).toBe("a $1.2B");
  });

  test("no figure, several leads, or none", () => {
    expect(houseHeadline({ name: "Firecrawl", amount: "", stage: "Series B", leads: [] })).toEqual({
      lead: "Firecrawl raised a Series B",
      figure: null,
      rest: "",
      by: "",
    });
    expect(houseHeadline({ name: "Firecrawl", amount: "", stage: "Undisclosed", leads: [] }).lead).toBe("Firecrawl raised a round");
    expect(houseHeadline({ name: "Firecrawl", amount: "$9M", stage: "Other", leads: [] }).rest).toBe(" round");
    expect(houseHeadline({ name: "F", amount: "$5M", stage: "Seed", leads: ["A", "B"] }).by).toBe(", led by A and B");
    expect(houseHeadline({ name: "F", amount: "$5M", stage: "Seed", leads: ["A", "B", "C"] }).by).toBe(", led by A and others");
  });
});

test("houseFreshSince is the window's first day, as the store's since filter reads it", () => {
  expect(houseFreshSince(NOW)).toBe("2026-09-15");
});
