// LANDING=1: `/` serves the landing page, the proxy's other duties stay as they were, and the
// landing page's pure helpers (counters, snippets, highlighting) say what the store holds.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { frontDoor, homeRedirect, LANDING_PATH, OVERVIEW_PATH, viewerFrom } from "../lib/access";
import { compactJson, tokenizeJson, tokenizeShell } from "../lib/code-tokens";
import { BASIC_CHALLENGE } from "../lib/dashboard-auth";
import { apiExample, apiPreview, grouped, landingStats, mcpConfig } from "../lib/landing";
import { NAV_DISPLAY, visibleNav } from "../lib/nav";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { gate } from "../proxy";
import { record, testDb } from "./helpers";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";
const rewrite = (res: Response) => res.headers.get("x-middleware-rewrite");

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
});

describe("frontDoor", () => {
  test("landing wins over demo; demo alone is the feed; neither leaves / alone", () => {
    expect(frontDoor("/", { demo: false, landing: true })).toBe(LANDING_PATH);
    expect(frontDoor("/", { demo: true, landing: true })).toBe(LANDING_PATH);
    expect(frontDoor("/", { demo: true, landing: false })).toBe("/feed");
    expect(frontDoor("/", { demo: false, landing: false })).toBeNull();
  });

  test("only `/` is a front door", () => {
    for (const path of ["/feed", "/home", "/companies/acme.com", "/api/v1/rounds"]) {
      expect(frontDoor(path, { demo: true, landing: true }), path).toBeNull();
    }
  });
});

describe("homeRedirect", () => {
  test("only a private instance's `/` goes to /overview; a front door keeps `/`", () => {
    expect(homeRedirect("/", { demo: false, landing: false })).toBe(OVERVIEW_PATH);
    expect(homeRedirect("/", { demo: true, landing: false })).toBeNull();
    expect(homeRedirect("/", { demo: false, landing: true })).toBeNull();
    expect(homeRedirect("/", { demo: true, landing: true })).toBeNull();
    for (const path of ["/overview", "/feed", "/home"]) expect(homeRedirect(path, { demo: false, landing: false }), path).toBeNull();
  });
});

describe("proxy with LANDING=1", () => {
  test("public demo: `/` rewrites to the landing page, the feed stays at /feed, admin paths keep the challenge", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("LANDING", "1");
    process.env.DASHBOARD_PASSWORD = "secret";

    const home = gate(new NextRequest("http://app.test/"));
    expect(new URL(rewrite(home) ?? "").pathname).toBe(LANDING_PATH);
    // The query string rides along, so a campaign tag on `/` reaches the page.
    expect(rewrite(gate(new NextRequest("http://app.test/?ref=x")))).toContain(`${LANDING_PATH}?ref=x`);

    for (const path of ["/feed", "/home", "/companies/acme", "/api/v1/rounds"]) {
      const res = gate(new NextRequest(`http://app.test${path}`));
      expect(passed(res), path).toBe(true);
      expect(rewrite(res), path).toBeNull();
    }
    const settings = gate(new NextRequest("http://app.test/settings"));
    expect(settings.status).toBe(401);
    expect(settings.headers.get("www-authenticate")).toBe(BASIC_CHALLENGE["www-authenticate"]);
  });

  test("private instance: the password still gates `/`, and an authorized request gets the landing page", () => {
    vi.stubEnv("LANDING", "1");
    process.env.DASHBOARD_PASSWORD = "secret";
    expect(gate(new NextRequest("http://app.test/")).status).toBe(401);
    const authed = gate(new NextRequest("http://app.test/", { headers: { authorization: `Basic ${b64("u:secret")}` } }));
    expect(new URL(rewrite(authed) ?? "").pathname).toBe(LANDING_PATH);
  });

  test("no password: `/` rewrites to the landing page", () => {
    vi.stubEnv("LANDING", "1");
    expect(new URL(rewrite(gate(new NextRequest("http://app.test/"))) ?? "").pathname).toBe(LANDING_PATH);
  });
});

describe("proxy without LANDING (the self-host default)", () => {
  const location = (res: Response) => res.headers.get("location");

  test("`/` redirects to the Overview with its query, and /overview and /home pass as they are", () => {
    const home = gate(new NextRequest("http://app.test/?preset=seed"));
    expect(home.status).toBe(307);
    expect(location(home)).toBe("http://app.test/overview?preset=seed");
    for (const path of ["/overview", "/home"]) {
      const res = gate(new NextRequest(`http://app.test${path}`));
      expect(passed(res), path).toBe(true);
      expect(rewrite(res), path).toBeNull();
    }
  });

  test("the password is asked before the redirect, so an unauthorized `/` learns nothing", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    expect(gate(new NextRequest("http://app.test/")).status).toBe(401);
    const authed = gate(new NextRequest("http://app.test/", { headers: { authorization: `Basic ${b64("u:secret")}` } }));
    expect(authed.status).toBe(307);
    expect(location(authed)).toBe("http://app.test/overview");
  });

  test("LANDING set to anything but 1 is off", () => {
    vi.stubEnv("LANDING", "true");
    expect(gate(new NextRequest("http://app.test/")).status).toBe(307);
  });

  test("demo mode still serves the feed at `/`", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(rewrite(gate(new NextRequest("http://app.test/?stage=seed")))).toContain("/feed?stage=seed");
  });
});

describe("Overview in all four LANDING and PUBLIC_DEMO combinations", () => {
  const combos = [
    { landing: false, demo: false, door: null },
    { landing: false, demo: true, door: "/feed" },
    { landing: true, demo: false, door: LANDING_PATH },
    { landing: true, demo: true, door: LANDING_PATH },
  ];

  test("every viewer's nav lists Overview first, and /overview answers without a rewrite", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const admin = `Basic ${b64("u:secret")}`;
    for (const { landing, demo } of combos) {
      vi.stubEnv("LANDING", landing ? "1" : "");
      vi.stubEnv("PUBLIC_DEMO", demo ? "1" : "");
      const label = `LANDING=${landing} PUBLIC_DEMO=${demo}`;
      for (const auth of [null, admin]) {
        const hrefs = visibleNav(viewerFrom(auth)).map((n) => n.href);
        expect(hrefs[0], label).toBe("/overview");
        expect(hrefs[1], label).toBe("/feed");
      }
      // A visitor keeps only the public sections in demo mode; everyone else sees them all.
      expect(visibleNav(viewerFrom(null)).length, label).toBe(demo ? 6 : NAV_DISPLAY.length);
      const res = gate(new NextRequest("http://app.test/overview", { headers: { authorization: admin } }));
      expect(passed(res), label).toBe(true);
      expect(rewrite(res), label).toBeNull();
    }
  });

  test("`/` is unchanged: the landing page, else the demo's feed, else the Overview", () => {
    for (const { landing, demo, door } of combos) {
      vi.stubEnv("LANDING", landing ? "1" : "");
      vi.stubEnv("PUBLIC_DEMO", demo ? "1" : "");
      const label = `LANDING=${landing} PUBLIC_DEMO=${demo}`;
      expect(frontDoor("/", { demo, landing }), label).toBe(door);
      const res = gate(new NextRequest("http://app.test/"));
      if (door) expect(new URL(rewrite(res) ?? "").pathname, label).toBe(door);
      else expect(res.headers.get("location"), label).toBe("http://app.test/overview");
    }
  });
});

describe("counter helpers", () => {
  test("grouped separates thousands", () => {
    expect(grouped(1241)).toBe("1,241");
    expect(grouped(7)).toBe("7");
  });
});

describe("snippets", () => {
  test("apiExample quotes every URL and starts with the Series A call", () => {
    const script = apiExample("https://fireround.dev", "2026-09-15");
    const calls = script.split("\n").filter((l) => l.startsWith("curl"));
    expect(calls[0]).toBe('curl "https://fireround.dev/api/v1/rounds?stage=series_a&limit=5"');
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toMatch(/^curl "[^"]+"$/);
    expect(script).toContain("since=2026-09-15");
  });

  test("mcpConfig points a client at /api/mcp", () => {
    expect(JSON.parse(mcpConfig("https://fireround.dev"))).toEqual({ mcpServers: { fireround: { url: "https://fireround.dev/api/mcp" } } });
  });
});

describe("tokenizers", () => {
  const join = (ts: Array<{ text: string }>) => ts.map((t) => t.text).join("");

  test("JSON: lossless, keys apart from string values", () => {
    const src = '{ "stage": "series_a", "usd_millions": 22.5, "leads": [null, true] }';
    const tokens = tokenizeJson(src);
    expect(join(tokens)).toBe(src);
    expect(tokens.find((t) => t.text === '"stage"')?.kind).toBe("key");
    expect(tokens.find((t) => t.text === '"series_a"')?.kind).toBe("string");
    expect(tokens.find((t) => t.text === "22.5")?.kind).toBe("number");
    expect(tokens.find((t) => t.text === "null")?.kind).toBe("literal");
  });

  test("shell: commands after && and at the start, flags, URLs, comments", () => {
    const src = "git clone https://github.com/firecrawl/fireround.git && cd fireround   # comment";
    const tokens = tokenizeShell(src);
    expect(join(tokens)).toBe(src);
    const kind = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect(kind("git")).toBe("command");
    expect(kind("clone")).toBe("plain");
    expect(kind("https://github.com/firecrawl/fireround.git")).toBe("string");
    expect(kind("cd")).toBe("command");
    expect(kind("# comment")).toBe("comment");
    expect(tokenizeShell('curl "https://x.test/?a=1&b=2" -o out.csv').map((t) => t.kind)).toEqual([
      "command",
      "plain",
      "string",
      "plain",
      "flag",
      "plain",
      "plain",
    ]);
  });
});

describe("compactJson", () => {
  const value = {
    data: [{ company: { name: "Acme", domain: "acme.com" }, sources: [{ url: `https://news.example/${"x".repeat(80)}` }], tags: [] }],
    next_cursor: null,
  };

  test("parses back to the value it was given", () => {
    expect(JSON.parse(compactJson(value, 72))).toEqual(value);
  });

  test("short objects stay on one line, long ones break, a one-member object stays whole", () => {
    const out = compactJson(value, 72);
    expect(out).toContain('"company": { "name": "Acme", "domain": "acme.com" }');
    expect(out).toContain(`{ "url": "https://news.example/${"x".repeat(80)}" }`);
    expect(out.startsWith("{\n")).toBe(true);
    expect(compactJson({ a: 1 }, 72)).toBe('{ "a": 1 }');
  });
});

describe("landingStats and apiPreview", () => {
  test("count only what the feed publishes, and preview a row as a strict subset of the API's", async () => {
    const handle = await testDb();
    const today = new Date().toISOString().slice(0, 10);
    const usd = (m: number) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: today });
    await persistRecords(
      handle,
      [
        record({
          company_name: "Acme",
          announced_date: today,
          amount: usd(20),
          lead_investors: ["Big Fund"],
          other_investors: ["Small Fund"],
          sources: [
            { url: "https://news.example/acme", host: "news.example", title: "Acme raises $20M" },
            { url: "https://wire.example/acme", host: "wire.example", title: "Acme closes $20M" },
          ],
        }),
        record({
          company_name: "Beta",
          stage: "seed",
          announced_date: today,
          amount: usd(5),
          lead_investors: ["Big Fund"],
          sources: [{ url: "https://news.example/beta", host: "news.example", title: "Beta raises $5M" }],
          verification: { status: "unverified", notes: [], url: null },
        }),
        record({
          company_name: "Gamma",
          announced_date: today,
          amount: usd(50),
          lead_investors: ["Hidden Capital"],
          sources: [{ url: "https://news.example/gamma", host: "news.example", title: "Gamma raises $50M" }],
        }),
      ],
      "series-a-b",
      "run-landing-1",
    );
    const { rows } = await listRounds(handle, { company: "gamma", includeReview: true });
    await setDisposition(handle, rows[0].id, "review");
    for (const company of ["Acme", "Beta"]) {
      const { rows: candidates } = await listRounds(handle, { company, includeReview: true });
      await setDisposition(handle, candidates[0].id, company === "Acme" ? "publish" : "flagged");
    }

    const s = await landingStats(handle);
    const published = await listRounds(handle, {});
    expect(s.records).toBe(published.rows.length);
    expect(s.records).toBe(2);
    expect(s.verified).toBe(
      published.rows.filter((r) => r.disposition === "publish" && ["confirmed", "corrected"].includes(r.verification?.status ?? "")).length,
    );
    // The article pages behind the verified rounds only: Beta is Developing and Gamma sits in review, so their pages do not count.
    const verifiedRows = published.rows.filter(
      (r) => r.disposition === "publish" && ["confirmed", "corrected"].includes(r.verification?.status ?? ""),
    );
    expect(s.articles).toBe(new Set(verifiedRows.flatMap((r) => r.sources.map((x) => x.url))).size);
    expect(s.verified).toBe(1);
    expect(s.articles).toBe(2);
    // Big Fund and Small Fund; Hidden Capital sits on a round in review.
    expect(s.investors).toBe(2);
    expect(s.rounds_7d).toBe(2);
    expect(s.usd_7d).toBe(25);

    const acme = published.rows.find((r) => r.company.name === "Acme");
    if (!acme) throw new Error("Acme missing");
    const preview = apiPreview(acme, "cursor-1");
    // Every key the preview shows is one the API row carries, with the same value.
    const row = preview.data[0];
    expect(row.company.name).toBe(acme.company.name);
    expect(row.amount).toEqual({ as_written: acme.amount.as_written, usd_millions: acme.amount.usd_millions });
    expect(row.verification).toEqual({ status: acme.verification?.status });
    expect(row.sources.map((x) => x.url)).toEqual(acme.sources.slice(0, 2).map((x) => x.url));
    expect(preview.next_cursor).toBe("cursor-1");
  });
});
