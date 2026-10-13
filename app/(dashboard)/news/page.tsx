import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { type NewsDayEntry, NewsDays } from "@/components/news-days";
import { PresetSwitcher } from "@/components/preset-switcher";
import { RelativeDay } from "@/components/relative-day";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { CardListSkeleton, PresetChipsSkeleton, SectionHeadingSkeleton } from "@/components/ui/skeletons";
import { Tag } from "@/components/ui/tag";
import { seesReview, viewer } from "@/lib/access";
import { trackClick } from "@/lib/analytics";
import { cachedNews, cachedPresets } from "@/lib/cached";
import { db } from "@/lib/db";
import { grouped, hostLabel, laneLabel, stageOf, usd } from "@/lib/format";
import { companyHref } from "@/lib/links";
import { type NewsEntry, type NewsItem, readNews } from "@/lib/news";
import { PRESET_PARAM } from "@/lib/preset-param";
import { presetOptions } from "@/lib/presets";
import { shareMetadata } from "@/lib/share";

/** Round chips a card shows before it folds the rest into a count. */
const CHIP_LIMIT = 8;

/** Source pages per step of "Load older"; the `show` param widens the window by this much. */
const PAGE = 80;
/** The widest window a URL can ask for, so a hand-typed `show` cannot scan the whole store. */
const MAX_SHOW = PAGE * 25;

/** The meta line under a headline: publisher and day are content, so normal case, legible ink. */
const meta = "text-label-x-small text-black-alpha-56";

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

type RoundChip = NewsItem["rounds"][number];

/** The company pill a card shows per round it reported: logo, name, stage, amount, lead on a story. */
function RoundPill({ r, withLead }: { r: RoundChip; withLead: boolean }) {
  const amount = r.usd_millions !== null ? usd(r.usd_millions) : r.amount_as_written;
  return (
    <Link
      href={companyHref(r.company_id)}
      className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border-faint pl-1 pr-2.5 text-label-x-small transition-colors hover:bg-black-alpha-4"
    >
      <CompanyLogo id={r.company_id} name={r.company} domain={r.domain} logoUrl={r.logo_url} size={16} />
      <span className="truncate">{r.company}</span>
      <span className="shrink-0 text-black-alpha-56">· {stageOf(r)}</span>
      {amount && <span className="shrink-0 font-mono text-[11px] tabular-nums">{amount}</span>}
      {withLead && r.lead && <span className="truncate text-black-alpha-56">led by {r.lead}</span>}
    </Link>
  );
}

/** The publisher block every card shares: favicon, host, day, and the lane for an admin. */
function CardMeta({
  host,
  publishedAt,
  query,
  readOnly,
}: {
  host: string;
  publishedAt: string | null;
  query: string | null;
  readOnly: boolean;
}) {
  const lane = laneLabel(query);
  return (
    <div className={`mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 ${meta}`}>
      <CompanyLogo name={hostLabel(host)} domain={host} size={14} />
      <span className="[overflow-wrap:anywhere]">{hostLabel(host)}</span>
      <span aria-hidden>·</span>
      <span>
        <RelativeDay iso={publishedAt} />
      </span>
      {/* The lane is a short status word, so it takes the bracket tag; its case is kept for "Watch: host". */}
      {!readOnly && lane && (
        <span title={lane.detail} className="ml-1">
          <Tag preserveCase>{lane.label}</Tag>
        </span>
      )}
    </div>
  );
}

/** One article: a two-line title, its evidence excerpt, a mono meta line, then the rounds it reported as pills. */
function Article({ it, readOnly }: { it: NewsItem; readOnly: boolean }) {
  return (
    <div className="px-5 py-4">
      <a
        href={it.url}
        target="_blank"
        rel="noreferrer"
        className="group flex items-start gap-2"
        {...trackClick("fireround_source_clicked", { location: "news", source_host: hostLabel(it.host) })}
      >
        <span className="line-clamp-2 min-w-0 flex-1 text-label-medium [overflow-wrap:anywhere] group-hover:underline">
          {it.title ?? it.url}
        </span>
        <ExternalLink className="mt-1 size-3.5 shrink-0 text-black-alpha-32" />
      </a>
      {it.excerpt && <p className="mt-1.5 line-clamp-2 text-body-small text-muted-foreground">{it.excerpt}</p>}
      <CardMeta host={it.host} publishedAt={it.published_at} query={it.query} readOnly={readOnly} />
      {it.rounds.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {it.rounds.slice(0, CHIP_LIMIT).map((r) => (
            <RoundPill key={r.id} r={r} withLead={it.rounds.length === 1} />
          ))}
          {it.rounds.length > CHIP_LIMIT && <Tag>+{it.rounds.length - CHIP_LIMIT} more</Tag>}
        </div>
      )}
    </div>
  );
}

/** One round the wires carried: the best publisher's headline, the evidence, the round pill, then the other copies. */
function StoryCard({ s, readOnly }: { s: Extract<NewsEntry, { kind: "story" }>; readOnly: boolean }) {
  return (
    <div className="px-5 py-4">
      <a
        href={s.primary.url}
        target="_blank"
        rel="noreferrer"
        className="group flex items-start gap-2"
        {...trackClick("fireround_source_clicked", { location: "news", source_host: hostLabel(s.primary.host) })}
      >
        <span className="line-clamp-2 min-w-0 flex-1 text-label-medium [overflow-wrap:anywhere] group-hover:underline">
          {s.primary.title ?? s.primary.url}
        </span>
        <ExternalLink className="mt-1 size-3.5 shrink-0 text-black-alpha-32" />
      </a>
      {s.excerpt && <p className="mt-1.5 line-clamp-2 text-body-small text-muted-foreground">{s.excerpt}</p>}
      <CardMeta host={s.primary.host} publishedAt={s.primary.published_at} query={s.primary.query} readOnly={readOnly} />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <RoundPill r={s.round} withLead />
      </div>
      {s.also.length > 0 && (
        <div className={`mt-2 flex flex-wrap items-center gap-x-3 ${meta}`}>
          <span>Also in</span>
          {/* Four hosts in a row are small targets side by side: each gets a 24px line and touch hit slop. */}
          {s.also.slice(0, 4).map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="tap relative inline-flex min-h-6 items-center hover:text-foreground hover:underline"
              {...trackClick("fireround_source_clicked", { location: "news", source_host: hostLabel(a.host) })}
            >
              {hostLabel(a.host)}
            </a>
          ))}
          {s.also.length > 4 && <span>+{s.also.length - 4} more</span>}
        </div>
      )}
    </div>
  );
}

/** Widens the window by a step; shown while source pages lie past it, under the list or under an empty window. */
function LoadOlder({ href, show, total }: { href: string; show: number; total: number }) {
  return (
    <div className="flex flex-col items-center gap-2 pb-2">
      {/* scroll={false}: the older days append below, so the reader stays where they were. */}
      <Button asChild variant="outline">
        <Link href={href} scroll={false}>
          Load older
        </Link>
      </Button>
      <span className="text-label-x-small text-muted-foreground">
        The latest <span className="font-mono tabular-nums">{grouped(show)}</span> of{" "}
        <span className="font-mono tabular-nums">{grouped(total)}</span> articles
      </span>
    </div>
  );
}

async function NewsBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const [search, presets, v] = await Promise.all([searchParams, cachedPresets(), viewer()]);
  // The `preset` param narrows the list; a slug no file matches reads as all.
  const wanted = one(search[PRESET_PARAM]);
  const preset = presets.some((p) => p.slug === wanted) ? wanted : "";
  const readOnly = v.demo && !v.admin;
  // `show` widens the window of source pages in steps of PAGE rather than paging by offset: a
  // story folds every copy of a round, and an offset page would split a story across two pages.
  const asked = Number.parseInt(one(search.show), 10);
  const show = Number.isFinite(asked) ? Math.min(MAX_SHOW, Math.max(PAGE, Math.ceil(asked / PAGE) * PAGE)) : PAGE;
  // Every article page, filings and social posts aside, is the count: the same set listStories scans, so the button hides
  // once the window covers it. A visitor's
  // list is one shared cache entry a minute (lib/cached.ts); an admin reads it fresh.
  const { items, total } = seesReview(v)
    ? await readNews(await db(), { limit: show, preset: preset || undefined })
    : await cachedNews(preset, show);
  const older = total > show && show < MAX_SHOW;
  const olderHref = `/news?${new URLSearchParams({ ...(preset ? { [PRESET_PARAM]: preset } : {}), show: String(show + PAGE) })}`;
  if (items.length === 0) {
    return (
      <PageBody width="narrow">
        <PresetSwitcher presets={presetOptions(presets)} />
        <div className="rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground">
          {/* The window can miss while older pages match (a preset, or a visitor's published-only view), so it says which. */}
          {older
            ? `Nothing${preset ? " for this watchlist" : ""} in the latest ${grouped(show)} articles.`
            : preset
              ? "No articles for this watchlist."
              : readOnly
                ? "No articles yet."
                : "No articles yet. Run a sweep first."}
        </div>
        {older && <LoadOlder href={olderHref} show={show} total={total} />}
      </PageBody>
    );
  }
  // Grouped by publish day on the reader's calendar (components/news-days.tsx); undated pages sort under their fetch day.
  const entries: NewsDayEntry[] = items.map((it) =>
    it.kind === "story"
      ? {
          key: `story-${it.primary.id}`,
          at: it.primary.published_at ?? it.primary.fetched_at,
          node: <StoryCard s={it} readOnly={readOnly} />,
        }
      : { key: it.item.id, at: it.item.published_at ?? it.item.fetched_at, node: <Article it={it.item} readOnly={readOnly} /> },
  );
  return (
    <PageBody width="narrow">
      <PresetSwitcher presets={presetOptions(presets)} />
      <NewsDays entries={entries} />
      {older && <LoadOlder href={olderHref} show={show} total={total} />}
    </PageBody>
  );
}

/** The news page's shape while it loads: the preset chips, then two day groups of article cards. */
function NewsSkeleton() {
  return (
    <PageBody width="narrow">
      <PresetChipsSkeleton />
      <section>
        <SectionHeadingSkeleton />
        <CardListSkeleton rows={5} />
      </section>
      <section>
        <SectionHeadingSkeleton />
        <CardListSkeleton rows={3} />
      </section>
    </PageBody>
  );
}

export const metadata = {
  title: "News",
  ...shareMetadata({
    title: "Funding news",
    description: "The articles and filings behind the funding record, by day, each linked to the rounds it reported.",
    image: "root",
    canonical: "/news",
  }),
};

export default function NewsPage({ searchParams }: PageProps<"/news">) {
  return (
    <>
      <PageHeader section={2} />
      <Suspense fallback={<NewsSkeleton />}>
        <NewsBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
