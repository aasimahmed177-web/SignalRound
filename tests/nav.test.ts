import { describe, expect, test } from "vitest";
import { matchSections, paletteOptions } from "../components/search/palette-items";
import { NAV, NAV_DISPLAY, navIndex, navItemsFor, visibleNav } from "../lib/nav";

describe("NAV", () => {
  test("indices keep their meaning: pages pass them as section={n}", () => {
    expect(NAV.map((n) => n.href)).toEqual([
      "/overview",
      "/feed",
      "/news",
      "/presets",
      "/runs",
      "/review",
      "/settings",
      "/companies",
      "/investors",
    ]);
  });

  test("Overview keeps index 0 at its own address", () => {
    expect(NAV[0]).toMatchObject({ href: "/overview", label: "Overview" });
  });

  test("the sidebar opens on Overview, with the directories right under the Feed", () => {
    expect(NAV_DISPLAY.map((n) => n.href)).toEqual([
      "/overview",
      "/feed",
      "/companies",
      "/investors",
      "/news",
      "/presets",
      "/runs",
      "/review",
      "/settings",
    ]);
  });

  test("a demo visitor keeps Overview and the directories", () => {
    expect(visibleNav({ demo: true, admin: false }).map((n) => n.href)).toEqual([
      "/overview",
      "/feed",
      "/companies",
      "/investors",
      "/news",
    ]);
  });

  test("navItemsFor maps hrefs back in the order given and drops unknowns", () => {
    expect(navItemsFor(["/news", "/nope", "/feed"]).map((n) => n.label)).toEqual(["News", "Feed"]);
    expect(navItemsFor(undefined)).toBe(NAV_DISPLAY);
  });
});

describe("navIndex", () => {
  const items = NAV_DISPLAY;
  const at = (path: string, list = items) => list[navIndex(path, list)]?.href ?? null;

  test("a section and the pages below it", () => {
    expect(at("/overview")).toBe("/overview");
    expect(at("/feed")).toBe("/feed");
    expect(at("/companies")).toBe("/companies");
    expect(at("/companies/acme.com")).toBe("/companies");
    expect(at("/investors/big%20fund")).toBe("/investors");
    expect(at("/settings")).toBe("/settings");
  });

  test("a prefix is not a match: /newsletter is not News", () => {
    expect(navIndex("/newsletter", items)).toBe(-1);
  });

  test("`/` renders in the dashboard only as the demo's feed, so Feed lights, for a visitor and an admin", () => {
    expect(at("/", visibleNav({ demo: true, admin: false }))).toBe("/feed");
    expect(at("/", visibleNav({ demo: true, admin: true }))).toBe("/feed");
  });

  test("/overviews is not Overview", () => {
    expect(navIndex("/overviews", items)).toBe(-1);
  });
});

describe("palette options", () => {
  test("an empty query offers every section", () => {
    expect(matchSections(NAV_DISPLAY, " ").length).toBe(NAV_DISPLAY.length);
  });

  test("sections match on label, prefix first", () => {
    expect(matchSections(NAV_DISPLAY, "in").map((n) => n.label)).toEqual(["Investors", "Settings"]);
    expect(matchSections(NAV_DISPLAY, "robots")).toEqual([]);
  });

  test("hits follow sections; the feed hand-off goes last, and only when the viewer can see the feed", () => {
    const hits = {
      companies: [{ kind: "company" as const, id: "acme.com", name: "Acme", detail: "acme.com", domain: "acme.com", logo_url: null }],
      investors: [{ kind: "investor" as const, id: "big fund", name: "Big Fund", detail: "2 rounds", domain: null, logo_url: null }],
    };
    const options = paletteOptions(NAV_DISPLAY, "ac", hits);
    expect(options.map((o) => [o.group, o.href])).toEqual([
      ["Companies", "/companies/acme.com"],
      ["Investors", "/investors/big-fund"],
      ["Search", "/feed?q=ac&view=latest"],
    ]);
    const noFeed = NAV_DISPLAY.filter((n) => n.href !== "/feed");
    expect(paletteOptions(noFeed, "ac", hits).some((o) => o.group === "Search")).toBe(false);
  });
});
