// What an agent or answer engine reads instead of the HTML: /llms.txt (https://llmstxt.org), which
// says what the site is, how to read its records, and where the pages, the API, and the MCP server
// are; and a company's page as markdown. Pure over their inputs, so the tests pin them without a server.

import { API_ENDPOINTS } from "@/lib/api-docs";
import type { CompanyPage } from "@/lib/company";
import { roundStageLabel } from "@/lib/format";
import { REPO_URL } from "@/lib/landing";
import { companyHref } from "@/lib/links";
import { asOfSentence, citable, fundingSummary } from "@/lib/seo";
import { capitalise } from "@/lib/share";

/**
 * /llms.txt. `base` is where the pages are kept (the canonical base), `origin` this deployment, which
 * serves the API and the MCP server. The public feeds are listed only where they answer (a public instance).
 */
export function llmsTxt(base: string, origin: string, feeds: Record<string, Array<{ url: string; title: string }>> | undefined): string {
  const feedLinks = Object.values(feeds ?? {}).flatMap((links) => links.map((l) => `- [${l.title}](${origin}${l.url})`));
  return [
    "# Fireround",
    "",
    "> Fireround is an open-source startup funding feed built on Firecrawl. It finds funding announcements across the open web, pre-seed to growth, extracts each round into a structured record (company, stage, amount, announcement date, lead and other investors), merges duplicate reports, and checks each round against the pages that reported it. Every round links to its sources.",
    "",
    "How to read a round:",
    "",
    "- Published rounds were confirmed against their sources. Flagged rounds are listed for a reader to check and are not confirmed. Pages and the API show only these two; nothing in review or rejected is public.",
    '- Certainty: "announced" means the company or a wire announced the round; "reported" means the press reported it, usually citing people familiar; "expected" means a raise still in progress that has not closed.',
    "- Amounts are as the source wrote them, with a USD conversion when the currency differs. Dates are announcement dates; some are known only to the week or the month.",
    '- A company page opens with a dated summary ("As of 13 Oct 2026, Acme has raised $20M across 2 verified rounds on record; latest: …") counted over published, closed rounds only, and carries the same rounds as schema.org JSON-LD with their amounts, dates, stages, lead investors, and source URLs.',
    "",
    "Page types:",
    "",
    `- \`${base}/companies/{id}\`: one company's funding rounds, the sources behind each, and its investors. The same page as markdown is at \`${base}/companies/{id}/index.md\`.`,
    `- \`${base}/investors/{id}\`: one investor's rounds led and joined, its co-investors, stages, and sectors.`,
    "",
    "## Pages",
    "",
    `- [Funding feed](${base}/feed): every round, newest first, filterable by stage, sector, amount, and date`,
    `- [Overview](${base}/overview): the funding market this week: capital, the biggest rounds, stages, sectors, and the most active leads`,
    `- [Companies](${base}/companies): every company with a round on record, its latest round, and its total raised`,
    `- [Investors](${base}/investors): every investor named on a round, with the rounds it led and joined`,
    `- [News](${base}/news): the articles behind the rounds`,
    "",
    "## API",
    "",
    `- [API reference](${origin}/docs): every read endpoint with parameters and examples; JSON by default, CSV and JSON Lines for rounds`,
    `- [OpenAPI document](${origin}/api/v1/openapi.json): the full contract, for client generators and custom GPT actions`,
    ...API_ENDPOINTS.map((e) => `- [GET ${e.path}](${origin}/docs#${e.id}): ${e.summary}`),
    "",
    "## MCP server",
    "",
    `- [MCP endpoint](${origin}/api/mcp): Streamable HTTP. Connect with \`{ "url": "${origin}/api/mcp" }\`. Read tools list and search rounds, read one company or investor, list companies, investors, top lead investors, trending rounds, and news.`,
    ...(feedLinks.length ? ["", "## Feeds", "", ...feedLinks] : []),
    "",
    "## Optional",
    "",
    `- [Source code](${REPO_URL}): the open-source repository, MIT licensed`,
    `- [Sitemap](${origin}/sitemap.xml): every public company and investor page, dated by its latest round`,
    "",
  ].join("\n");
}

/** A table cell: no pipe or line break can end it early. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** How many sources each round's row links; the HTML page lists them all. */
const SOURCES_LISTED = 3;

/**
 * A company page as markdown: the dated summary, what the company does, and its citable rounds
 * (published, verified, and closed), each with its leads and sources. A flagged round stays on the
 * HTML page, where it wears its status.
 */
export function companyMarkdown(page: CompanyPage, base: string, asOf: Date): string {
  const { company } = page;
  const summary = fundingSummary(company.name, page.rounds);
  const rounds = page.rounds.filter(citable);
  const facts = [
    company.website ? `Website: ${company.website}` : null,
    company.hq ? `Headquarters: ${company.hq}` : null,
    `Page: ${base}${companyHref(company.id)}`,
  ].filter(Boolean);
  const lines = [`# ${company.name} funding rounds and investors`, ""];
  if (summary) lines.push(asOfSentence(summary, asOf), "");
  const what = capitalise(company.description);
  if (what) lines.push(what, "");
  lines.push(facts.join("  \n"), "");
  if (rounds.length) {
    lines.push(
      "## Verified rounds",
      "",
      "| Announced | Round | Amount | Lead investors | Other investors | Sources |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rounds.map((r) => {
        const date = r.announced_on
          ? `${r.announced_on.slice(0, r.date_precision === "day" ? 10 : 7)}${r.certainty === "reported" ? " (reported)" : ""}`
          : "undated";
        const sources = r.sources
          .slice(0, SOURCES_LISTED)
          .map((s) => `[${cell(s.host)}](${s.url})`)
          .join(", ");
        return `| ${[
          date,
          cell(`${roundStageLabel(r)}${r.is_extension ? " extension" : ""}`),
          cell(r.amount.as_written ?? "undisclosed"),
          cell(r.lead_investors.join(", ") || "not stated"),
          cell(r.other_investors.join(", ") || "none named"),
          sources || "none listed",
        ].join(" | ")} |`;
      }),
      "",
    );
  }
  lines.push(`Source: Fireround (${base}), an open-source funding feed. Each round is checked against the pages listed with it.`, "");
  return lines.join("\n");
}
