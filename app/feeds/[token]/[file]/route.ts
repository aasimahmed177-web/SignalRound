// Literal feeds: /feeds/{token}/{preset}.rss | .atom | .json
// The token is the secret (feed readers cannot send auth headers); it is stored hashed and revocable.
// Item ids are a URN built from the record id (feedItemId), stable across new -> updated so readers
// do not duplicate.

import { createHash } from "node:crypto";
import { schema } from "@fireround/core/db";
import { and, eq, isNull } from "drizzle-orm";
import { Feed } from "feed";
import { isPublicDemo } from "@/lib/access";
import { db } from "@/lib/db";
import { acceptsCertainty } from "@/lib/deliverable";
import { esc } from "@/lib/digest";
import { hostLabel, stageLabel, stageOf, usd } from "@/lib/format";
import { companyHref, webUrl } from "@/lib/links";
import type { RoundRow } from "@/lib/persist";
import { listRounds } from "@/lib/persist";
import { listPresets } from "@/lib/presets";
import { ALL_ROUNDS, feedItemId } from "@/lib/public-feeds";
import { readAgainst } from "@/lib/source-count";
import { capitalizeFirst } from "@/lib/text";

// A reader (Slack's RSS app among them) shows the title as written, so every stage reads as a word,
// and a stage that names nothing ("undisclosed", "other") is left out of the sentence.
const stageWords = (r: { stage: string; stage_as_written: string }) => (r.stage === "undisclosed" || r.stage === "other" ? "" : stageOf(r));
/** What follows "raises" in a title: "$5M Seed", else "a Seed round", else "a round". */
const raised = (amount: string, stage: string) => (amount ? `${amount} ${stage}`.trim() : `a ${stage ? `${stage} ` : ""}round`);

/**
 * The figure as a headline says it: the page's own words without their asides, so "$125m (up from
 * $100m)" reads "$125m" and "£1.825 million (~$2.2 million)" reads "£1.825 million"; USD when the page's
 * words are missing.
 */
function headlineAmount(r: RoundRow): string {
  const written = (r.amount.as_written ?? "").replace(/\s*\([^)]*\)/g, "").trim();
  return written || (r.amount.usd_millions ? usd(r.amount.usd_millions) : "");
}

/**
 * A reader's view of a round: the raise in a sentence, what the company does, the pages it was read
 * against, and the way back to Fireround. Slack's RSS app shows the start of this under the title, so
 * the sentence comes first and nothing in it is machinery (no status, no score). Every value came off
 * the web through an extractor and a reader renders HTML, so each one is escaped.
 */
function describe(r: RoundRow, pageUrl: string): string {
  const amount = headlineAmount(r);
  const stage = stageWords(r);
  const leads = r.lead_investors.length ? ` led by ${r.lead_investors.join(", ")}` : "";
  const raise = `${r.company.name} ${r.certainty === "expected" ? "plans to raise" : "raised"} ${raised(amount, stage)}${leads}.`.replace(
    /\s+/g,
    " ",
  );
  const about = [capitalizeFirst(r.company.description), r.company.domain].filter(Boolean).join(" · ");
  const sources = r.sources
    .slice(0, 4)
    .map((s) => {
      const href = webUrl(s.url);
      return href ? `<a href="${esc(href)}">${esc(hostLabel(s.host))}</a>` : esc(hostLabel(s.host));
    })
    .join(", ");
  // The same count and claim as the feed's row (lib/source-count.ts): the sources listed, "verified"
  // only for a verified row that is not flagged, with "1 of 2" when pages arrived after the read.
  const count = r.sources.length;
  const reach = r.disposition === "flagged" ? null : readAgainst(r);
  const listed = `${count} ${count === 1 ? "source" : "sources"}`;
  const checked = !count ? "" : reach ? `Verified against ${reach}: ${sources}. ` : `Developing, ${listed}: ${sources}. `;
  return [
    `<p><strong>${esc(raise)}</strong></p>`,
    about ? `<p>${esc(about)}</p>` : "",
    `<p>${checked}<a href="${esc(pageUrl)}">Open on Fireround</a></p>`,
  ].join("");
}

export async function GET(request: Request, ctx: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await ctx.params;
  const m = /^([a-z0-9-]+)\.(rss|atom|json)$/.exec(file);
  if (!m) return new Response("not found", { status: 404 });
  const [, preset, format] = m;

  const handle = await db();
  // In demo mode the literal token "public" reads every preset (and "all"), no token row needed;
  // outside demo it is just an unknown token and 404s like any other.
  const isPublic = isPublicDemo() && token === "public";
  let includeExpected = false;
  if (!isPublic) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const allowed = await handle
      .select({ presetSlug: schema.feedTokens.presetSlug, includeExpected: schema.feedTokens.includeExpected })
      .from(schema.feedTokens)
      .where(and(eq(schema.feedTokens.tokenHash, tokenHash), isNull(schema.feedTokens.revokedAt)))
      .limit(1);
    if (allowed.length === 0) return new Response("not found", { status: 404 });

    // A scoped token reads only its preset, and a made-up slug is nothing at all; the same
    // response as a bad token, so neither check reveals which failed.
    const scoped = allowed[0].presetSlug;
    if (scoped !== null && scoped !== preset) return new Response("not found", { status: 404 });
    includeExpected = allowed[0].includeExpected;
  }
  // "all" mixes every preset; only the public token may ask for it.
  const presetName = preset === "all" ? ALL_ROUNDS.name : (await listPresets(handle)).find((p) => p.slug === preset)?.name;
  if (!presetName) return new Response("not found", { status: 404 });
  if (preset === "all" && !isPublic) return new Response("not found", { status: 404 });

  const origin = new URL(request.url).origin;
  // A feed is news: history rows (earlier rounds promoted from dossiers) never enter it.
  const listed = await listRounds(handle, { preset: preset === "all" ? undefined : preset, limit: 100, history: "exclude" });
  const rows = listed.rows.filter((r) => acceptsCertainty(r, includeExpected));
  const feed = new Feed({
    title: `Fireround: ${presetName}`,
    description: "Funding rounds reported on the open web, extracted with Firecrawl.",
    id: `${origin}/feeds/${preset}`,
    link: `${origin}/`,
    language: "en",
    updated: rows[0] ? new Date(rows[0].last_seen_at) : new Date(),
    generator: "fireround",
    feedLinks: {
      rss: `${origin}/feeds/${token}/${preset}.rss`,
      atom: `${origin}/feeds/${token}/${preset}.atom`,
      json: `${origin}/feeds/${token}/${preset}.json`,
    },
  });
  for (const r of rows) {
    const amount = headlineAmount(r);
    // The item opens the company's page on Fireround, not the article: in Slack the link unfurls into
    // the page's share card (logo, latest round, total raised), and the sources sit in the description.
    const page = `${origin}${companyHref(r.company.id)}`;
    feed.addItem({
      // The feed library wraps titles in CDATA rather than escaping them, so the escape happens here.
      title: esc(
        `${r.company.name} ${r.certainty === "expected" ? "plans to raise" : "raises"} ${raised(amount, stageWords(r))}`
          .replace(/\s+/g, " ")
          .trim(),
      ),
      id: feedItemId(r.id),
      link: page,
      description: describe(r, page),
      content: describe(r, page),
      date: r.announced_on ? new Date(`${r.announced_on}T12:00:00Z`) : new Date(r.first_seen_at),
      published: new Date(r.first_seen_at),
      category: [{ name: stageLabel(r.stage) }, ...(r.company.sector ? [{ name: r.company.sector }] : [])],
    });
  }
  const body = format === "rss" ? feed.rss2() : format === "atom" ? feed.atom1() : feed.json1();
  const type = format === "rss" ? "application/rss+xml" : format === "atom" ? "application/atom+xml" : "application/feed+json";
  // The CDN answers a feed reader's poll for two minutes, then serves the old copy once while it fetches the next.
  return new Response(body, {
    headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=120, s-maxage=120, stale-while-revalidate=600" },
  });
}
