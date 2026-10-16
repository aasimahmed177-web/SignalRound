import { ArrowRight, ArrowUpRight, Braces, Building2, Rows3, Send, Share2, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { CodeFrame, CodeLines } from "@/components/marketing/code";
import { CopyButton } from "@/components/marketing/copy-button";
import {
  ApiExamples,
  ApiExamplesSkeleton,
  Counters,
  CountersSkeleton,
  HouseMoment,
  JustIn,
  LiveGlimpse,
  LiveGlimpseSkeleton,
  LiveSlackPreview,
  WeekLine,
} from "@/components/marketing/live";
import { LiveSlackSubscribe } from "@/components/marketing/live-slack-subscribe";
import { GitHubMark, VercelMark } from "@/components/marketing/marks";
import { Band, container, Eyebrow, gutter, primaryButton, SectionHead, secondaryButton, textLink } from "@/components/marketing/section";
import { SlackPreviewSkeleton } from "@/components/marketing/slack-preview";
import { SlackSubscribeSkeleton } from "@/components/marketing/slack-subscribe";
import { JsonLd } from "@/components/seo/json-ld";
import { Tag } from "@/components/ui/tag";
import { isLanding, isPublicDemo } from "@/lib/access";
import { trackClick } from "@/lib/analytics";
import { digestsConfigured } from "@/lib/digest";
import { feedAlternateTypes } from "@/lib/feed-discovery";
import { DEPLOY_URL, ENV_EXAMPLE, QUICK_START, REPO_URL } from "@/lib/landing";
import { canonicalBase, canonicalUrl } from "@/lib/origin";
import { siteJsonLd } from "@/lib/seo";
import { publicSlackConfig } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

const TITLE = "SignalRound: who just raised, found without scraping credits";
const DESCRIPTION =
  "Self-hosted startup funding discovery from public feeds and first-party websites, with source-backed public contact emails and no Firecrawl credits.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  // With LANDING=1 the page is served at `/`, so that is the address a search engine should keep.
  alternates: isLanding() ? { canonical: canonicalUrl("/"), types: feedAlternateTypes() } : undefined,
  // Setting openGraph here replaces the root's, image included, so the site card is named again.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "SignalRound",
    type: "website",
    url: canonicalUrl(isLanding() ? "/" : "/home"),
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/opengraph-image"] },
};

const SECTIONS = 4;

const OPENAPI_PATH = "/api/v1/openapi.json";

interface Step {
  primitive: string;
  title: string;
  body: string;
  trace: string;
  links: Array<{ href: string; label: string }>;
}

/** The native pipeline implemented in lib/native-collector.ts. */
const STEPS: Step[] = [
  {
    primitive: "Discover",
    title: "Feeds find funding articles",
    body: "RSS and Atom sources surface current announcements. Strict headline rules reject valuation stories and phrases that merely use words such as raise.",
    trace: "rss + atom · real sources",
    links: [{ href: `${REPO_URL}/blob/main/lib/native-collector.ts`, label: "Collector source" }],
  },
  {
    primitive: "Inspect",
    title: "Direct HTTP reads the source",
    body: "The collector fetches the article itself with timeouts and response limits, then keeps the original URL, title, author, publication date, and feed provenance.",
    trace: "direct fetch · bounded read",
    links: [{ href: `${REPO_URL}#collector-options`, label: "Run it" }],
  },
  {
    primitive: "Resolve",
    title: "The company and round are parsed",
    body: "Company, amount, and stage come from the announcement. Scored first-party links resolve the company website without trusting an unrelated link on the page.",
    trace: "company · amount · stage",
    links: [{ href: `${REPO_URL}/blob/main/tests/native-collector.test.ts`, label: "Precision tests" }],
  },
  {
    primitive: "Contact",
    title: "First-party pages expose public inboxes",
    body: "The homepage and contact/about pages are checked for role addresses on the same domain. Personal and support-only addresses are excluded.",
    trace: "website · public role email",
    links: [{ href: `${REPO_URL}/blob/main/README.md`, label: "Method and limits" }],
  },
];

interface Feature {
  icon: typeof Rows3;
  lead: string;
  body: string;
  href: string;
  cta: string;
  external?: boolean;
}

const FEATURES: Feature[] = [
  {
    icon: Rows3,
    lead: "The feed.",
    body: "Every round with its logo, stage, amount, lead, and a Verified mark with its source count. Sort by Trending for the rounds X, the press, and Hacker News are talking about.",
    href: "/feed",
    cta: "Open the feed",
  },
  {
    icon: Building2,
    lead: "Companies and investors.",
    body: "A page for each: every round on record, total raised, the syndicate, co-investors, and source-backed company facts.",
    href: "/companies",
    cta: "Browse companies",
  },
  {
    icon: Braces,
    lead: "The API.",
    body: "Rounds, companies, investors, and funding news over /api/v1: JSON, CSV, or JSONL, with the same filters as the feed. Described in OpenAPI.",
    href: "/docs",
    cta: "API reference",
  },
  {
    icon: Sparkles,
    lead: "The MCP server.",
    body: "Tools at /api/mcp, so an agent can list, search, and read rounds the way the dashboard does.",
    href: "#api",
    cta: "See the config",
  },
  {
    icon: Send,
    lead: "Delivery.",
    body: digestsConfigured()
      ? "Slack in one click, RSS, Atom, and JSON Feed, Standard Webhooks, and an email digest, each from one outbox."
      : "Slack in one click, RSS, Atom, and JSON Feed, and Standard Webhooks, each from one outbox.",
    href: "#delivery",
    cta: "See a round in Slack",
  },
  {
    icon: Share2,
    lead: "Share cards.",
    body: "A company or investor link unfurls in Slack with its logo, latest round, and total raised.",
    href: "/investors",
    cta: "Browse investors",
  },
];

interface Channel {
  name: string;
  body: string;
  link?: { href: string; label: string };
}

/** The four ways a round leaves the outbox, as lib/delivery.ts and docs/slack.md describe them; Email only where digests are configured. */
const CHANNELS: Channel[] = [
  {
    name: "Slack",
    body: "Add to Slack picks a channel on Slack's own screen, and each new round posts as the message shown here, or one digest each morning. No app to make? Copy a /feed command and Slack's RSS app posts the rounds instead.",
    link: { href: `${REPO_URL}/blob/main/docs/slack.md`, label: "Slack setup" },
  },
  {
    name: "Feeds",
    body: "RSS, Atom, and JSON Feed for each watchlist: public, as on this instance, or behind a private token you can revoke.",
  },
  {
    name: "Webhooks",
    body: "A signed JSON event per round, in the Standard Webhooks format, so any receiver that speaks it can check the signature.",
    link: { href: "https://www.standardwebhooks.com", label: "Standard Webhooks" },
  },
  {
    name: "Email",
    body: "A digest a day or a week with every round since the last one, sent through Resend.",
  },
];

const FACTS: Array<[string, string]> = [
  ["License", "MIT"],
  ["Runtime", "Node 24+ and pnpm"],
  ["Database", "Embedded Postgres, or any Postgres 15+"],
  ["Schedule", "Vercel cron, or pnpm start ticks itself"],
];

/** An outbound link that says so: the arrow, a new tab. */
function Out({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn(textLink, className)}>
      {children}
      <ArrowUpRight className="size-3.5 opacity-70" aria-hidden />
    </a>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden border-b border-border-faint">
      {/* A hairline grid behind the words, fading out from the top centre: firecrawl.dev's ruled ground, drawn in CSS. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_55%_at_50%_0%,black_20%,transparent_75%)]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--ink-8) 1px, transparent 1px), linear-gradient(to bottom, var(--ink-8) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          backgroundPosition: "center top",
        }}
      />
      <div className={cn(container, gutter, "pt-16 pb-14 sm:pt-24 sm:pb-20")}>
        {/* A slide with no fade: the headline is the page's largest paint, and one that starts at
            opacity 0 is not counted until the fade ends, which put 700ms on LCP. */}
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-700">
          <h1
            id="hero-title"
            className="text-[40px] leading-[44px] font-medium tracking-[-0.03em] text-balance sm:text-[60px] sm:leading-[62px] lg:text-[68px] lg:leading-[70px]"
          >
            Who just raised, <span className="text-heat-hot">checked at the source.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-[17px] leading-7 text-muted-foreground text-pretty sm:text-[19px] sm:leading-8">
            Pre-seed to growth, each round linked to <span className="whitespace-nowrap">the pages that reported it.</span>
            <br className="hidden sm:block" /> <span className="whitespace-nowrap">Open source, direct-web, no scraping credits.</span>
          </p>
          <div className="mt-9 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
            <Link href="/feed" className={primaryButton}>
              Open the feed <ArrowRight className="size-4" aria-hidden />
            </Link>
            <a
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              className={secondaryButton}
              {...trackClick("fireround_deploy_clicked", { location: "hero" })}
            >
              <VercelMark />
              Deploy your own
            </a>
          </div>
        </div>
        <div className="mx-auto mt-14 max-w-5xl sm:mt-16">
          <Suspense fallback={<LiveGlimpseSkeleton />}>
            <LiveGlimpse />
          </Suspense>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <Band id="how">
      <Eyebrow index={1} total={SECTIONS}>
        How it works
      </Eyebrow>
      <SectionHead title="How a round gets into the feed.">
        The native collector follows four inspectable steps. It reads public sources directly and records where every article, website, and
        email came from.
      </SectionHead>
      <ol className="grid border-t border-border-faint sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li
            key={s.primitive}
            className={cn(
              "flex flex-col gap-4 border-border-faint px-5 py-8 sm:px-8 lg:px-10 lg:py-10",
              i > 0 && "border-t sm:border-t-0",
              i % 2 === 1 && "sm:border-l",
              i >= 2 && "sm:border-t lg:border-t-0",
              i >= 1 && "lg:border-l",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[13px] text-black-alpha-32 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <Tag>{s.primitive}</Tag>
            </div>
            <h3 className="text-title-h6">{s.title}</h3>
            <p className="text-body-medium text-muted-foreground">{s.body}</p>
            <div className="mt-auto space-y-3 pt-2">
              <p className="truncate rounded-6 bg-black-alpha-4 px-2.5 py-1.5 font-mono text-[12px] text-black-alpha-64">{s.trace}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {s.links.map((l) => (
                  <Out key={l.href} href={l.href} className="text-label-small">
                    {l.label}
                  </Out>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Band>
  );
}

function Product() {
  return (
    <Band id="product">
      <Eyebrow index={2} total={SECTIONS}>
        What you get
      </Eyebrow>
      <SectionHead title="Read it in the dashboard, pull it from the API, or hand it to an agent.">
        The dashboard, feeds, API, and MCP server all use the same verified data, so an agent sees exactly what you see.
      </SectionHead>
      <ul className="grid gap-px border-y border-border-faint bg-border-faint sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          const cta = (
            <>
              {f.cta}
              {f.external ? <ArrowUpRight className="size-3.5 opacity-70" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
            </>
          );
          return (
            <li key={f.lead} className="flex flex-col gap-5 bg-background px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
              <Icon className="size-5 text-black-alpha-48" strokeWidth={1.5} aria-hidden />
              <p className="text-[17px] leading-7">
                <span className="font-medium text-foreground">{f.lead}</span> <span className="text-muted-foreground">{f.body}</span>
              </p>
              <div className="mt-auto">
                {f.external ? (
                  <a href={f.href} target="_blank" rel="noreferrer" className={cn(textLink, "text-label-small")}>
                    {cta}
                  </a>
                ) : f.href.startsWith("#") ? (
                  <a href={f.href} className={cn(textLink, "text-label-small")}>
                    {cta}
                  </a>
                ) : (
                  <Link
                    href={f.href}
                    className={cn(textLink, "text-label-small")}
                    {...(f.href === "/docs" ? trackClick("fireround_api_docs_opened", { location: "product", target: "docs" }) : {})}
                  >
                    {cta}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div id="api" className={cn("scroll-mt-16 space-y-6 pt-16 pb-16 sm:pt-20 sm:pb-20", gutter)}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h3 className="text-title-h5">Query it with curl, or connect it to an agent.</h3>
            <p className="max-w-2xl text-body-medium text-muted-foreground">
              The same records over HTTP and over MCP. The response below is a row from this instance, trimmed to a few fields.
            </p>
          </div>
          <div className="flex shrink-0 gap-5">
            <Link
              href="/docs"
              className={cn(textLink, "text-label-small")}
              {...trackClick("fireround_api_docs_opened", { location: "api", target: "docs" })}
            >
              All endpoints <ArrowRight className="size-3.5" aria-hidden />
            </Link>
            <a
              href={OPENAPI_PATH}
              target="_blank"
              rel="noreferrer"
              className={cn(textLink, "text-label-small")}
              {...trackClick("fireround_api_docs_opened", { location: "api", target: "openapi" })}
            >
              OpenAPI <ArrowUpRight className="size-3.5 opacity-70" aria-hidden />
            </a>
          </div>
        </div>
        <Suspense fallback={<ApiExamplesSkeleton />}>
          <ApiExamples />
        </Suspense>
      </div>
    </Band>
  );
}

function Delivery() {
  return (
    <Band id="delivery">
      <Eyebrow index={3} total={SECTIONS}>
        Delivery
      </Eyebrow>
      <div className={cn("grid gap-10 py-16 sm:py-20 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14", gutter)}>
        <div className="flex flex-col">
          <h2 className="max-w-md text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]">
            {digestsConfigured() ? "Get new rounds in Slack, by RSS, or by email." : "Get new rounds in Slack or by RSS."}
          </h2>
          <p className="mt-4 max-w-md text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
            Each new round goes to every channel you set up, and a failed send is retried with backoff. On your own instance you set
            channels up in Settings, under Delivery; here you can add this feed to Slack or read it as RSS.
          </p>
          <ul className="mt-10 divide-y divide-border-faint border-y border-border-faint">
            {CHANNELS.filter((c) => c.name !== "Email" || digestsConfigured()).map((c) => (
              <li key={c.name} className="grid gap-1.5 py-4 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-6">
                <span className="text-label-medium">{c.name}</span>
                <div className="space-y-1.5">
                  <p className="text-body-small text-muted-foreground">{c.body}</p>
                  {c.link && (
                    <Out href={c.link.href} className="text-label-small">
                      {c.link.label}
                    </Out>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-body-small text-muted-foreground">
            The retries, the digest window, and the webhook headers in full.{" "}
            <Out href={`${REPO_URL}/blob/main/docs/how-it-works.md#durable-execution-and-delivery`} className="text-label-small">
              How it works
            </Out>
          </p>
        </div>
        {/* The preview rides along while the channels scroll past; with the subscribe card under it the column is as tall as the list, so it stays put. */}
        <div className={cn("min-w-0 space-y-3 self-start lg:pt-2", !isPublicDemo() && "lg:sticky lg:top-24")}>
          <Suspense fallback={<SlackPreviewSkeleton />}>
            <LiveSlackPreview />
          </Suspense>
          <p className="text-body-small text-muted-foreground">
            The message delivery posts, built from a round in this feed. The buttons open the round and its primary source.
          </p>
          {/* The public demo lets a visitor subscribe a channel themselves: Add to Slack when it is configured, Slack's RSS app always. */}
          {isPublicDemo() && (
            <div className="pt-5">
              <Suspense fallback={<SlackSubscribeSkeleton install={publicSlackConfig() !== null} />}>
                <LiveSlackSubscribe />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </Band>
  );
}

function SelfHost() {
  return (
    <Band id="self-host">
      <Eyebrow index={4} total={SECTIONS}>
        Self-host
      </Eyebrow>
      <div className={cn("grid gap-10 py-16 sm:py-20 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:gap-14", gutter)}>
        <div className="flex flex-col">
          <h2 className="max-w-md text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]">
            Run your own in four commands.
          </h2>
          <p className="mt-4 max-w-md text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
            No database or paid scraping key to set up: without a database URL it runs on embedded Postgres under ./data. The native
            collector reads public feeds and first-party sites directly; add your own schedule when you are ready.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              className={primaryButton}
              {...trackClick("fireround_deploy_clicked", { location: "self_host" })}
            >
              <VercelMark />
              Deploy to Vercel
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className={secondaryButton}
              {...trackClick("fireround_github_clicked", { location: "self_host" })}
            >
              <GitHubMark />
              Read the README
            </a>
          </div>
          <p className="mt-4 text-body-small text-muted-foreground">No Firecrawl account or credits are required for native collection.</p>
          <dl className="mt-10 divide-y divide-border-faint border-y border-border-faint">
            {FACTS.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-6 py-3">
                <dt className="text-mono-x-small text-black-alpha-32">{k}</dt>
                <dd className="text-right text-body-small text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="min-w-0 space-y-4 self-start">
          <CodeFrame label="Terminal" action={<CopyButton text={QUICK_START} snippet="quick_start" />}>
            <CodeLines code={QUICK_START} lang="shell" />
          </CodeFrame>
          <CodeFrame label=".env" action={<CopyButton text={ENV_EXAMPLE} snippet="env" />}>
            <CodeLines code={ENV_EXAMPLE} lang="shell" />
          </CodeFrame>
          <p className="text-body-small text-muted-foreground">
            Every other variable is optional; the README lists them.{" "}
            <Out href={`${REPO_URL}#configuration`} className="text-label-small">
              Configuration
            </Out>
          </p>
        </div>
      </div>
    </Band>
  );
}

function Closing() {
  return (
    <section className="border-b border-border-faint">
      <div className={cn(container, gutter, "flex flex-col items-center py-20 text-center sm:py-28")}>
        <h2 className="text-[36px] leading-[40px] font-medium tracking-[-0.025em] sm:text-[52px] sm:leading-[56px]">The feed is live.</h2>
        <p className="mt-4 max-w-xl text-[17px] leading-7 text-muted-foreground">
          <Suspense fallback="Every round links to the articles that reported it.">
            <WeekLine />
          </Suspense>
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/feed" className={primaryButton}>
            Open the feed <ArrowRight className="size-4" aria-hidden />
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className={secondaryButton}
            {...trackClick("fireround_github_clicked", { location: "closing" })}
          >
            <GitHubMark />
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

/**
 * fireround.dev: what Fireround is, the live feed as it stands, how a record is made, what reads
 * it, where it is delivered, and how to run your own. What this instance spends stays off the page:
 * it runs on the operator's key, and a visitor never sees credits. The words and frames are
 * static and prerender; the glimpse, the counters, the house moment, the API example, and the
 * Slack message stream from the store.
 */
export default function LandingPage() {
  return (
    <>
      <JsonLd data={siteJsonLd(canonicalBase(), DESCRIPTION)} />
      <Hero />
      <Band>
        <Suspense fallback={<CountersSkeleton />}>
          <Counters />
        </Suspense>
      </Band>
      <Suspense fallback={null}>
        <HouseBand />
      </Suspense>
      <Suspense fallback={null}>
        <JustInBand />
      </Suspense>
      <HowItWorks />
      <Product />
      <Delivery />
      <SelfHost />
      <Closing />
    </>
  );
}

/** The Just in band, only when the store has a round, so an empty store leaves no empty rule. */
async function JustInBand() {
  const strip = await JustIn();
  if (!strip) return null;
  return <Band id="just-in">{strip}</Band>;
}

/** The house moment's band, only when it has something to say, so a stale round leaves no empty rule. */
async function HouseBand() {
  const moment = await HouseMoment();
  if (!moment) return null;
  return <Band>{moment}</Band>;
}
