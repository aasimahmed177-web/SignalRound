import { headers } from "next/headers";
import { Fragment, type ReactNode } from "react";
import { SlackCopy } from "@/components/feed/slack-copy";
import { SlackSubscribePopover } from "@/components/feed/slack-subscribe-popover";
import { isLanding, LANDING_PATH } from "@/lib/access";
import { cachedPresets } from "@/lib/cached";
import { grouped, usd } from "@/lib/format";
import { publicOrigin } from "@/lib/origin";
import { presetOptions } from "@/lib/presets";
import { publicFeed, publicFeeds } from "@/lib/public-feeds";
import { publicSlackConfig } from "@/lib/slack-subscriptions";
import type { DemoStats } from "@/lib/stats";

/** A figure inside the sentence: mono and full ink, so the numbers carry the strip. */
function Figure({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-foreground tabular-nums">{children}</span>;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const FEEDS = [
  { label: "RSS", href: (slug: string) => `/feeds/public/${slug}.rss` },
  { label: "Atom", href: (slug: string) => `/feeds/public/${slug}.atom` },
  { label: "JSON", href: (slug: string) => `/feeds/public/${slug}.json` },
  { label: "API", href: () => "/api/v1/rounds" },
  // The endpoint answers only JSON-RPC POSTs; a reader who clicks wants the client config, which the landing page's MCP tab shows.
  { label: "MCP", href: () => `${isLanding() ? "/" : LANDING_PATH}#mcp` },
  { label: "OpenAPI", href: () => "/api/v1/openapi.json" },
];

/**
 * The public demo's front door (PUBLIC_DEMO=1 rewrites `/` to the feed), one strip high on desktop:
 * the week and the day as two short phrases on the left, the ways to subscribe on the right. On a
 * phone each phrase keeps its words together and the strip wraps between them, never off the edge.
 * The pitch and the Deploy button live on the page header, so the rounds start near the fold.
 * `house` is the featured house round, carried as the card's first row so the demo shows one card.
 * Slack leads the Subscribe line: with the public install on it opens Add to Slack (the preset in
 * view preselected) with the /feed command under it; without, it copies the /feed command.
 */
export async function DemoHero({ stats, preset, house }: { stats: DemoStats; preset: string; house?: ReactNode }) {
  // The preset comes off the query string; anything that is not a slug falls back to every round.
  const slug = /^[a-z0-9-]+$/.test(preset) ? preset : "all";
  // The Slack command needs the whole URL (Slack fetches it), so it is built on the instance's origin.
  const origin = publicOrigin(await headers());
  const { slack } = publicFeed(origin, { slug, name: slug });
  const install = publicSlackConfig() !== null;
  const feeds = install ? publicFeeds(origin, presetOptions(await cachedPresets())) : [];
  return (
    <section className="overflow-hidden rounded-12 border border-border-faint bg-card">
      {/* The house round, when one is fresh, leads the card above a hairline (components/feed/house-banner.tsx). */}
      {house && <div className="border-b border-border-faint">{house}</div>}
      <div className="flex flex-col gap-1.5 px-4 py-3 sm:px-5 lg:flex-row lg:items-baseline lg:justify-between lg:gap-8">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-body-small text-muted-foreground">
          <span className="whitespace-nowrap">
            <Figure>{grouped(stats.rounds_7d)}</Figure> {plural(stats.rounds_7d, "round", "rounds")},{" "}
            <Figure>{usd(stats.usd_7d) || "$0"}</Figure> in the last 7 days
          </span>
          <span className="text-black-alpha-16 dark:text-white/20" aria-hidden>
            |
          </span>
          <span className="whitespace-nowrap">
            <Figure>{grouped(stats.runs_24h)}</Figure> {plural(stats.runs_24h, "run", "runs")} today
          </span>
        </p>
        <div className="flex flex-col lg:items-end lg:gap-0.5">
          {/* Separators sit outside the links so a narrow line breaks between feeds, never inside one. */}
          <p className="text-body-small text-muted-foreground">
            Subscribe: {install ? <SlackSubscribePopover feeds={feeds} preset={slug} /> : <SlackCopy command={slack} />}
            {FEEDS.map((f) => (
              <Fragment key={f.label}>
                {" · "}
                <a href={f.href(slug)} className="whitespace-nowrap text-foreground hover:underline">
                  {f.label}
                </a>
              </Fragment>
            ))}
          </p>
          <p className="hidden text-body-small text-muted-foreground lg:block">Open source, and built on Firecrawl search and scrape.</p>
        </div>
      </div>
    </section>
  );
}
