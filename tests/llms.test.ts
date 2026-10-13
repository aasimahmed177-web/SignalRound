import { describe, expect, test } from "vitest";
import { API_ENDPOINTS } from "../lib/api-docs";
import { getCompany } from "../lib/company";
import { companyMarkdown, llmsTxt } from "../lib/llms";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("llmsTxt", () => {
  const txt = llmsTxt("https://fireround.dev", "https://fireround.dev", {
    "application/rss+xml": [{ url: "/feeds/public/all.rss", title: "Fireround: all rounds (RSS)" }],
  });

  test("follows the llms.txt shape: a title, a summary quote, then sections of links", () => {
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# Fireround");
    expect(lines[2]).toMatch(/^> Fireround is an open-source startup funding feed built on Firecrawl\./);
    expect(txt).toMatch(/^## Pages$/m);
    expect(txt).toMatch(/^## API$/m);
    expect(txt).toMatch(/^## MCP server$/m);
    expect(txt).toMatch(/^## Optional$/m);
  });

  test("names the API reference, the OpenAPI document, every endpoint, the MCP server, the page types, and the public feeds", () => {
    expect(txt).toContain("[API reference](https://fireround.dev/docs)");
    expect(txt).toContain("[OpenAPI document](https://fireround.dev/api/v1/openapi.json)");
    for (const e of API_ENDPOINTS) expect(txt).toContain(`[GET ${e.path}](https://fireround.dev/docs#${e.id})`);
    expect(txt).toContain("[MCP endpoint](https://fireround.dev/api/mcp)");
    expect(txt).toContain("`https://fireround.dev/companies/{id}`");
    expect(txt).toContain("`https://fireround.dev/companies/{id}/index.md`");
    expect(txt).toContain("`https://fireround.dev/investors/{id}`");
    expect(txt).toContain("[Fireround: all rounds (RSS)](https://fireround.dev/feeds/public/all.rss)");
  });

  test("a private instance lists no public feeds; pages follow the canonical base, the API this deployment", () => {
    const own = llmsTxt("https://www.example.com/funding", "https://fireround.dev", undefined);
    expect(own).not.toContain("## Feeds");
    expect(own).toContain("[Funding feed](https://www.example.com/funding/feed)");
    expect(own).toContain("[MCP endpoint](https://fireround.dev/api/mcp)");
  });
});

describe("companyMarkdown", () => {
  test("the dated summary and the verified rounds as a table; a flagged round stays off it", async () => {
    const db = await testDb();
    const rows = [
      record({
        company_name: "Acme",
        company_domain: "acme.com",
        company_description: "payments for robots",
        stage: "seed",
        announced_date: "2026-03-01",
        lead_investors: ["Big | Fund"],
      }),
      record({ company_name: "Acme", company_domain: "acme.com", stage: "series_a", announced_date: "2026-08-01" }),
    ];
    await persistRecords(db, rows, "series-a-b", "run-1");
    await setDisposition(db, rows[0].id, "publish");
    await setDisposition(db, rows[1].id, "flagged");
    const page = await getCompany(db, "acme.com");
    if (!page) throw new Error("no page");
    const md = companyMarkdown(page, "https://fireround.dev", new Date("2026-10-13T00:00:00Z"));
    expect(md.split("\n")[0]).toBe("# Acme funding rounds and investors");
    expect(md).toContain(
      "As of 13 Oct 2026, Acme has raised $20M across 1 verified round on record, plus 1 round still being checked; latest: $20M seed round led by Big | Fund, announced 1 Mar 2026.",
    );
    expect(md).toContain("Payments for robots");
    expect(md).toContain("Page: https://fireround.dev/companies/acme.com");
    expect(md).toContain("| 2026-03-01 | Seed | $20M | Big \\| Fund | none named | [reuters.com](https://reuters.com/acme) |");
    expect(md).not.toContain("Series A");
  });
});
