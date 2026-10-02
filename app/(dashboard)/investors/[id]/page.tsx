import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { RoundCheckMark } from "@/components/confidence";
import { RoleTag } from "@/components/disposition-tag";
import { HistoryMark } from "@/components/history-mark";
import { InvestorLogo } from "@/components/investor-logo";
import { IntentLink } from "@/components/shell/intent-link";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/dot";
import { BarListSkeleton, HeaderCardSkeleton, PanelSkeleton, StatRowSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { BarList, Panel, Stat } from "@/components/ui/stat";
import { seesReview, viewer } from "@/lib/access";
import { cachedInvestor } from "@/lib/cached";
import { db } from "@/lib/db";
import { approxDate, precisionNote, reportedAmount, roundStageLabel, sectorLabel, stageLabel, usd } from "@/lib/format";
import { getInvestor, investorTypeLabel } from "@/lib/investor";
import { companyHref, investorHref, investorIdFromParam } from "@/lib/links";
import { investorShare, shareMetadata } from "@/lib/share";
import { capitalizeFirst } from "@/lib/text";

const DESCRIPTION = "The rounds this investor is named on, who it invests beside, and where it shows up.";

// The body defers behind Suspense, so metadata for a live id streams in with it; a miss keeps "Investor".
// Link unfurlers (Slackbot and co.) get it blocking in <head>. The card is the colocated opengraph-image.
export async function generateMetadata({ params }: PageProps<"/investors/[id]">): Promise<Metadata> {
  const { id } = await params;
  // The visitor's view, from the shared cache the body reads too (lib/cached.ts).
  const page = await cachedInvestor(investorIdFromParam(id));
  if (!page) return { title: "Investor" };
  const share = investorShare(page);
  // The title is the share title ("Insight Partners: led 3 rounds · Fireround"), so a search result
  // reads like the unfurl; the canonical is the stored id, however the URL spelled it.
  const meta = shareMetadata({ title: share.title, description: share.description });
  const url = investorHref(page.investor.id);
  return { ...meta, title: share.title, alternates: { canonical: url }, openGraph: { ...meta.openGraph, url } };
}

/** Index into NAV for the Investors entry, so the sidebar lights it on an investor page. */
const SECTION = 8;

/** The one value in a count list that strictly leads it, or null when there is no clear favourite. */
function favourite<T extends { count: number }>(items: T[]): T | null {
  const [first, second] = items;
  return first && first.count > 1 && first.count > (second?.count ?? 0) ? first : null;
}

function Crumbs({ current }: { current?: string }) {
  return (
    <>
      <Link href="/feed" className="hover:text-foreground">
        Feed
      </Link>
      <span className="mx-1.5 text-black-alpha-24 dark:text-white/20">/</span>
      <Link href="/investors" className="hover:text-foreground">
        Investors
      </Link>
      {current && (
        <>
          <span className="mx-1.5 text-black-alpha-24 dark:text-white/20">/</span>
          <span className="text-foreground">{current}</span>
        </>
      )}
    </>
  );
}

async function InvestorBody({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const v = await viewer();
  // Every figure reads the feed's rounds; only a demo visitor gets a 404 for an investor the feed never
  // names. The visitor's page is one shared cache entry a minute (lib/cached.ts); an admin reads it fresh.
  const page = seesReview(v) ? await getInvestor(await db(), investorIdFromParam(id), true) : await cachedInvestor(investorIdFromParam(id));
  if (!page) notFound();
  const { investor, rounds, totals, reach, co_investors, sectors, stages } = page;
  // The stat row: how many rounds and in which seat, the money, the latest, and the company it keeps.
  // A card that would read 0 or n/a gives its place to one that says something.
  const latest = rounds[0] ?? null;
  const seats =
    totals.led === rounds.length
      ? rounds.length === 1
        ? "as lead investor"
        : "led every one"
      : totals.led === 0
        ? "joined, none as lead"
        : `led ${totals.led}, joined ${totals.participated}`;
  const money =
    totals.led > 0
      ? { label: "LED ROUNDS · USD", usd: totals.lead_share_usd_millions, rs: rounds.filter((r) => r.role === "lead") }
      : { label: "ROUNDS JOINED · USD", usd: reach.usd_millions, rs: rounds };
  const moneyStated = money.rs.filter((r) => r.amount.usd_millions).length;
  const topCo =
    co_investors[0] && co_investors[0].rounds > 1 && co_investors[0].rounds > (co_investors[1]?.rounds ?? 0) ? co_investors[0] : null;
  const site = investor.domain ? `https://${investor.domain}` : null;
  // What the investor's own homepage says it is, or "Individual investor" for a person; nothing when unknown.
  const kind = investorTypeLabel(investor.kind);
  const facts = [kind, investor.headquarters].filter((f): f is string => !!f);
  // The card's sentence: how much of the record it is on, and where it clusters when it clearly does.
  const topStage = favourite(stages);
  const topSector = favourite(sectors);
  const leaning = [topStage && `at ${stageLabel(topStage.stage)}`, topSector && `in ${sectorLabel(topSector.sector)}`].filter(Boolean);
  const dated = rounds.filter((r) => r.announced_on);
  const [newest, oldest] = [dated[0], dated.at(-1)];

  return (
    <>
      <PageHeader
        section={SECTION}
        title={investor.name}
        description={DESCRIPTION}
        breadcrumb={<Crumbs current={investor.name} />}
        actions={
          site && (
            <Button asChild variant="outline" size="sm">
              <a href={site} target="_blank" rel="noreferrer">
                Visit site <ExternalLink className="size-3.5" />
              </a>
            </Button>
          )
        }
      />
      <PageBody>
        {/* The company page's header card, for a firm: its tile, then what the record says about it. */}
        <div className="flex items-start gap-4 rounded-12 border border-border-faint bg-card p-5 sm:gap-5 sm:p-6">
          <InvestorLogo
            id={investor.id}
            name={investor.name}
            domain={investor.domain}
            logoUrl={investor.logo_url}
            size={48}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-body-medium">
              {rounds.length === 0
                ? "No rounds on the feed name this investor yet."
                : `Named on ${rounds.length === 1 ? "one round" : `${rounds.length} rounds`} in the feed${
                    leaning.length ? `, most often ${leaning.join(" and ")}` : ""
                  }.`}
            </p>
            {investor.description && (
              <p className="text-body-small text-muted-foreground" title={site ? `From ${investor.domain}` : undefined}>
                {investor.description}
              </p>
            )}
            {(facts.length > 0 || site || newest) && (
              <p className="text-body-small text-muted-foreground">
                {facts.map((f, i) => (
                  <span key={f} className="whitespace-nowrap">
                    {i > 0 && <Dot />}
                    {f}
                  </span>
                ))}
                {facts.length > 0 && (site || newest) && <Dot />}
                {site && (
                  <span className="whitespace-nowrap">
                    <a href={site} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                      {investor.domain}
                    </a>
                  </span>
                )}
                {site && newest && <Dot />}
                {newest && oldest && (
                  <span className="whitespace-nowrap">
                    {newest === oldest ? "Since " : "Rounds from "}
                    <span className="text-mono-small">{approxDate(oldest.announced_on, oldest.date_precision)}</span>
                    {newest !== oldest && (
                      <>
                        {" to "}
                        <span className="text-mono-small">{approxDate(newest.announced_on, newest.date_precision)}</span>
                      </>
                    )}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="ROUNDS" value={rounds.length} hint={seats} />
          <Stat
            label={money.label}
            value={usd(money.usd) || "Undisclosed"}
            hint={[
              moneyStated === 0
                ? `no ${totals.led > 0 ? "led " : ""}round states an amount`
                : moneyStated === money.rs.length
                  ? `across ${moneyStated} ${moneyStated === 1 ? "round" : "rounds"}`
                  : `${moneyStated} of ${money.rs.length} rounds state an amount`,
              // A co-led round counts its amount split evenly between the leads (lib/investor.ts).
              totals.led > 0 && totals.co_led > 0 && `${totals.co_led} co-led, split evenly`,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          {latest && (
            <Stat
              label="LATEST ROUND"
              value={latest.company.name}
              href={companyHref(latest.company.id)}
              hint={[
                `${roundStageLabel(latest)}${latest.is_extension ? " ext." : ""}`,
                usd(latest.amount.usd_millions) || latest.amount.as_written,
                latest.announced_on ? approxDate(latest.announced_on, latest.date_precision) : "undated",
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
          {reach.co_investors > 0 || sectors.length === 0 ? (
            <Stat
              label="CO-INVESTORS"
              value={reach.co_investors}
              hint={topCo ? `most often with ${topCo.name}` : reach.co_investors === 0 ? "none named beside it" : "named beside it"}
            />
          ) : (
            <Stat
              label="TOP SECTOR"
              value={sectorLabel(sectors[0].sector)}
              hint={`${sectors[0].count} of ${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}`}
            />
          )}
        </div>

        <Panel title="Rounds" code={String(rounds.length)} flush>
          {rounds.length === 0 ? (
            <p className="p-5 text-body-small text-muted-foreground">No rounds on the feed name this investor yet.</p>
          ) : (
            <>
              {/* Below md the five columns have nowhere to go: one block per round. */}
              <div className="divide-y divide-border-faint text-body-small md:hidden">
                {rounds.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 px-5 py-4">
                    <CompanyLogo
                      id={r.company.id}
                      name={r.company.name}
                      domain={r.company.domain}
                      logoUrl={r.company.logo_url}
                      size={32}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <IntentLink href={companyHref(r.company.id)} className="truncate text-label-medium hover:underline">
                          {r.company.name}
                        </IntentLink>
                        <RoleTag lead={r.role === "lead"} />
                      </div>
                      <div className="truncate text-black-alpha-56 dark:text-muted-foreground">
                        {capitalizeFirst(r.company.description) ?? r.company.domain ?? r.stage_as_written}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-mono-small">
                        <span>
                          {roundStageLabel(r)}
                          {r.is_extension && <span className="text-muted-foreground"> ext.</span>}
                        </span>
                        <span>{r.amount.usd_millions ? usd(r.amount.usd_millions) : (r.amount.as_written ?? "n/a")}</span>
                        {r.announced_on ? (
                          <span title={precisionNote(r.date_precision) ?? undefined}>{approxDate(r.announced_on, r.date_precision)}</span>
                        ) : (
                          <span className="text-black-alpha-32 dark:text-muted-foreground">undated</span>
                        )}
                        <RoundCheckMark r={r} compact />
                        <HistoryMark history={r.history} reportedLater={r.hold?.startsWith("reported later:")} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <table className="hidden w-full table-fixed text-body-small md:table">
                <thead className="text-left text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
                  <tr className="border-b border-border-faint">
                    <th className="py-2.5 pl-5 font-normal">Company</th>
                    <th className="w-32 py-2.5 font-normal">Round</th>
                    <th className="w-24 py-2.5 text-right font-normal">Amount</th>
                    <th className="w-32 py-2.5 pl-6 font-normal">Announced</th>
                    <th className="w-24 py-2.5 pr-5 pl-6 font-normal">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {rounds.map((r) => (
                    <tr key={r.id} className="border-b border-border-faint last:border-0">
                      <td className="py-3 pl-5 pr-4 align-top">
                        <div className="flex items-start gap-3">
                          <CompanyLogo
                            id={r.company.id}
                            name={r.company.name}
                            domain={r.company.domain}
                            logoUrl={r.company.logo_url}
                            size={28}
                            className="mt-1.5"
                          />
                          <div className="min-w-0 flex-1">
                            <IntentLink href={companyHref(r.company.id)} className="block truncate text-label-medium hover:underline">
                              {r.company.name}
                            </IntentLink>
                            <div className="truncate text-black-alpha-56 dark:text-muted-foreground">
                              {capitalizeFirst(r.company.description) ?? r.company.domain ?? r.stage_as_written}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 align-top">
                        <div className="truncate">
                          {roundStageLabel(r)}
                          {r.is_extension && <span className="text-muted-foreground"> ext.</span>}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <RoundCheckMark r={r} />
                          <HistoryMark history={r.history} reportedLater={r.hold?.startsWith("reported later:")} />
                        </div>
                      </td>
                      <td className="py-3 text-right align-top text-mono-small">
                        {reportedAmount(r) ?? <span className="text-black-alpha-32">n/a</span>}
                      </td>
                      <td className="py-3 pl-6 align-top text-mono-small">
                        {r.announced_on ? (
                          <span title={precisionNote(r.date_precision) ?? undefined}>{approxDate(r.announced_on, r.date_precision)}</span>
                        ) : (
                          <span className="font-normal text-black-alpha-32 dark:text-muted-foreground">undated</span>
                        )}
                      </td>
                      <td className="py-3 pr-5 pl-6 align-top">
                        <RoleTag lead={r.role === "lead"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Co-investors" code="SHARED ROUNDS">
            <BarList
              items={co_investors.map((c) => ({
                key: c.id,
                lead: <InvestorLogo id={c.id} name={c.name} domain={c.domain} logoUrl={c.logo_url} size={20} />,
                label: c.name,
                href: investorHref(c.id),
                value: c.rounds,
                detail: `${c.rounds} ${c.rounds === 1 ? "round" : "rounds"}`,
              }))}
              empty="No one else named on these rounds."
            />
          </Panel>
          <Panel title="Sectors" code="ROUNDS">
            <BarList
              items={sectors.map((s) => ({
                key: s.sector,
                label: sectorLabel(s.sector),
                value: s.count,
                detail: `${s.count} ${s.count === 1 ? "round" : "rounds"}`,
              }))}
              empty="No sector on record."
            />
          </Panel>
          <Panel title="Stages" code="ROUNDS">
            <BarList
              items={stages.map((s) => ({
                key: s.stage,
                label: stageLabel(s.stage),
                value: s.count,
                detail: `${s.count} ${s.count === 1 ? "round" : "rounds"}`,
              }))}
            />
          </Panel>
        </div>
      </PageBody>
    </>
  );
}

export default function InvestorPage({ params }: PageProps<"/investors/[id]">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader section={SECTION} title="Investor" description={DESCRIPTION} breadcrumb={<Crumbs />} />
          <PageBody>
            <HeaderCardSkeleton />
            <StatRowSkeleton />
            <PanelSkeleton title="Rounds" flush>
              <TableSkeleton
                rows={6}
                bar={false}
                className="rounded-none border-0"
                cols={["w-28", "w-20 text-right", "w-24", "w-16", "w-16 text-right"]}
              />
            </PanelSkeleton>
            <div className="grid gap-4 lg:grid-cols-3">
              <PanelSkeleton title="Co-investors" />
              <PanelSkeleton title="Sectors" />
              <PanelSkeleton title="Stages">
                <BarListSkeleton rows={4} />
              </PanelSkeleton>
            </div>
          </PageBody>
        </>
      }
    >
      <InvestorBody params={params} />
    </Suspense>
  );
}
