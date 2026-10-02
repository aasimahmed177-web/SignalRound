import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Pager } from "@/components/feed/pager";
import { InvestorLogo } from "@/components/investor-logo";
import { DirectoryControls } from "@/components/search/directory-controls";
import { IntentLink } from "@/components/shell/intent-link";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { PillSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { cachedInvestors } from "@/lib/cached";
import { DIRECTORY_PAGE_SIZE, directoryHref, INVESTOR_SORTS, type InvestorListing, parseDirectoryParams } from "@/lib/directory";
import { approxDate, precisionNote, roundStageLabel } from "@/lib/format";
import { companyHref, investorHref } from "@/lib/links";
import { shareMetadata } from "@/lib/share";
import { groupDigits } from "@/lib/text";
import { cn } from "@/lib/utils";

type Search = Record<string, string | string[] | undefined>;

const SORTS = [
  { value: "", label: "Latest activity" },
  { value: "rounds", label: "Most rounds" },
  { value: "led", label: "Most led" },
  { value: "name", label: "Name" },
];

const muted = "text-black-alpha-56 dark:text-muted-foreground";
const faint = "text-black-alpha-32 dark:text-muted-foreground";
const none = "text-black-alpha-32";

/** The newest round the investor sat on: whose it was and the day. The company links through. */
function Latest({ i }: { i: InvestorListing }) {
  if (!i.latest) return <span className={none}>n/a</span>;
  return (
    <>
      <span className="truncate">
        <IntentLink href={companyHref(i.latest.company_id)} className="hover:underline">
          {i.latest.company}
        </IntentLink>
        <span className={muted}> · {roundStageLabel(i.latest)}</span>
      </span>
      <span className={cn("block text-mono-small font-normal", muted)} title={precisionNote(i.latest.date_precision) ?? undefined}>
        {approxDate(i.latest.announced_on, i.latest.date_precision)}
      </span>
    </>
  );
}

function InvestorsList({ rows }: { rows: InvestorListing[] }) {
  const head = "py-2.5 text-left font-normal";
  const cell = "py-3 align-top";
  return (
    <>
      <ul className="divide-y divide-border-faint text-body-small md:hidden">
        {rows.map((i) => (
          <li key={i.id} className="relative flex items-start gap-3 px-4 py-3 hover:bg-black-alpha-4 dark:hover:bg-white/4">
            <InvestorLogo id={i.id} name={i.name} domain={i.domain} logoUrl={i.logo_url} size={32} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              {/* The name's ::after covers the card, so a tap anywhere opens the investor. */}
              <IntentLink href={investorHref(i.id)} className="block truncate text-label-medium after:absolute after:inset-0">
                {i.name}
              </IntentLink>
              <div className={cn("mt-0.5 flex flex-wrap gap-x-3", muted)}>
                <span>
                  <span className="text-mono-small text-foreground">{i.led}</span> led
                </span>
                <span>
                  <span className="text-mono-small text-foreground">{i.participated}</span> participated
                </span>
              </div>
              {i.latest && (
                <div className={cn("mt-1 truncate", muted)}>
                  Latest: {i.latest.company} · {roundStageLabel(i.latest)}{" "}
                  <span className={cn("text-mono-small font-normal", muted)}>
                    {approxDate(i.latest.announced_on, i.latest.date_precision)}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <table className="hidden w-full table-fixed text-body-small md:table">
        <thead className={cn("text-mono-x-small", faint)}>
          <tr className="border-b border-border-faint">
            <th className={cn(head, "w-auto pl-5")}>Investor</th>
            <th className={cn(head, "w-20 text-right")}>Led</th>
            <th className={cn(head, "w-28 text-right")}>Participated</th>
            <th className={cn(head, "w-20 text-right")}>Rounds</th>
            <th className={cn(head, "w-64 pl-8 pr-5")}>Latest activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr
              key={i.id}
              className="border-b border-border-faint transition-colors last:border-b-0 hover:bg-black-alpha-4 dark:hover:bg-white/4"
            >
              <td className={cn(cell, "pl-5 pr-4")}>
                {/* With a domain under the name the tile centres on both lines, as on /companies; alone, the name centres on the tile. */}
                <div className={cn("flex gap-3", i.domain ? "items-start" : "items-center")}>
                  <InvestorLogo
                    id={i.id}
                    name={i.name}
                    domain={i.domain}
                    logoUrl={i.logo_url}
                    size={28}
                    className={i.domain ? "mt-1.5" : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <IntentLink href={investorHref(i.id)} className="block truncate text-label-medium hover:underline">
                      {i.name}
                    </IntentLink>
                    {i.domain && <div className={cn("truncate", muted)}>{i.domain}</div>}
                  </div>
                </div>
              </td>
              <td className={cn(cell, "text-right text-mono-small", i.led === 0 && muted)}>{i.led}</td>
              <td className={cn(cell, "text-right text-mono-small", i.participated === 0 && muted)}>{i.participated}</td>
              <td className={cn(cell, "text-right text-mono-small")}>{i.total}</td>
              <td className={cn(cell, "pl-8 pr-5")}>
                <div className="flex min-w-0 flex-col">
                  <Latest i={i} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

async function InvestorsBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const { q, sort, page } = parseDirectoryParams(await searchParams, INVESTOR_SORTS);
  // The same for every visitor, so a page of it is cached for a few minutes (lib/cached.ts).
  const list = await cachedInvestors(q, sort, page);
  const carried = { q, sort: sort === INVESTOR_SORTS[0] ? "" : sort };

  return (
    <PageBody>
      <DirectoryControls placeholder="Investor name" label="Search investors" sorts={SORTS} />
      {list.total === 0 ? (
        <div className="rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground">
          {q ? (
            <>
              No investor matches "{q}".{" "}
              <Link href="/investors" className="text-foreground underline underline-offset-4">
                Show every investor
              </Link>{" "}
              or{" "}
              <Link href={`/feed?${new URLSearchParams({ q })}`} className="text-foreground underline underline-offset-4">
                search the feed
              </Link>
              .
            </>
          ) : (
            <>
              No investors yet. An investor shows here once a round that names it publishes to the feed.
              <div className="mt-4">
                <Button asChild variant="outline" size="sm">
                  <Link href="/feed">Open the feed</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-12 border border-border-faint bg-card">
          <div className="flex h-11 items-center border-b border-border-faint px-5">
            <div className={cn("text-mono-small font-normal", muted)}>
              {list.pages > 1
                ? `${groupDigits(list.from)} to ${groupDigits(list.to)} of ${groupDigits(list.total)}`
                : groupDigits(list.total)}{" "}
              <span className="font-sans">{list.total === 1 ? "investor" : "investors"}</span>
            </div>
          </div>
          <InvestorsList rows={list.rows} />
        </div>
      )}
      <Pager
        page={list.page}
        count={list.pages}
        total={list.total}
        size={DIRECTORY_PAGE_SIZE}
        hrefFor={(n) => directoryHref("/investors", carried, n)}
      />
    </PageBody>
  );
}

export const metadata = {
  title: "Investors",
  ...shareMetadata({
    title: "Investors",
    description:
      "Every investor named on a funding round: the rounds it led and joined, who it invests beside, and the stages and sectors it backs.",
    image: "root",
    canonical: "/investors",
  }),
};

export default function InvestorsPage({ searchParams }: PageProps<"/investors">) {
  return (
    <>
      <PageHeader section={8} />
      <Suspense
        fallback={
          <PageBody>
            <div className="flex items-center gap-2">
              <PillSkeleton className="w-auto min-w-0 flex-1 sm:w-72 sm:flex-none" />
              <PillSkeleton className="w-36" />
            </div>
            <TableSkeleton
              rows={10}
              rowPad="py-3"
              headPad="py-2.5"
              cardMeta={1}
              cols={["w-16 text-right", "w-24 text-right", "w-16 text-right", "w-56"]}
            />
          </PageBody>
        }
      >
        <InvestorsBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
