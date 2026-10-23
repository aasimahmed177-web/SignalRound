import { DEFAULT_TIERS, hostOf, priorKey } from "@fireround/core";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { connection } from "next/server";
import { Fragment, type ReactNode, Suspense } from "react";
import { FlameMark } from "@/components/brand/flame-mark";
import { DeepDiveButton } from "@/components/company/deep-dive-button";
import { DossierPanel } from "@/components/company/dossier-panel";
import { DossierPending } from "@/components/company/dossier-pending";
import { FounderList } from "@/components/company/founder-list";
import { OnX } from "@/components/company/on-x";
import { RefreshProfileButton } from "@/components/company/refresh-profile-button";
import { AlsoFound, RequestFundingHistory } from "@/components/company/request-funding-history";
import { RequestProgress } from "@/components/company/request-progress";
import { RequestProvenance } from "@/components/company/request-provenance";
import { RequestViewed } from "@/components/company/request-viewed";
import { RoundFold, RoundFoldPanel, RoundFoldToggle } from "@/components/company/round-verification";
import { ShowMore } from "@/components/company/show-more";
import { CompanyLogo } from "@/components/company-logo";
import { RoundCheckMark } from "@/components/confidence";
import { DispositionTag, RoleTag } from "@/components/disposition-tag";
import { BuiltWith } from "@/components/feed/built-with";
import { Buzz, BuzzInline } from "@/components/feed/buzz";
import { certaintyLabel, RoundCertainty, RoundCertaintyDetail } from "@/components/feed/round-certainty";
import { Verified } from "@/components/feed/verified";
import { HistoryMark } from "@/components/history-mark";
import { InvestorLogo } from "@/components/investor-logo";
import { PricingPlans } from "@/components/pricing-plans";
import { TrackView } from "@/components/product-analytics";
import { RelativeCheck, RelativeDay } from "@/components/relative-day";
import { JsonLd } from "@/components/seo/json-ld";
import { IntentLink } from "@/components/shell/intent-link";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/dot";
import { HeaderCardSkeleton, ListSkeleton, PanelSkeleton, SkeletonLine, StatRowSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { Panel, Stat } from "@/components/ui/stat";
import { seesReview, viewer } from "@/lib/access";
import { trackClick } from "@/lib/analytics";
import { cachedCompanyView } from "@/lib/cached";
import { inFeed, readCompanyView } from "@/lib/company";
import { companyFacts, factChips, LINKEDIN_TITLE } from "@/lib/company-facts";
import {
  dossierTotal,
  investorsByRound,
  mergeFounders,
  priorsOffRecord,
  roundAfter,
  sourcesByRound,
  totalToDate,
  unlistedBackers,
} from "@/lib/company-groups";
import { publicRequestStatus, STILL_CHECKING } from "@/lib/company-request-status";
import { companyRequestFor, requestTally } from "@/lib/company-requests";
import { db } from "@/lib/db";
import { companyRedirect } from "@/lib/entity-exists";
import { feedAlternateTypes } from "@/lib/feed-discovery";
import {
  approxDate,
  hostLabel,
  precisionNote,
  reportedAmount,
  roundStageLabel,
  sectorLabel,
  stageAsWrittenNote,
  usd,
  valuationLabel,
} from "@/lib/format";
import { isHouseCompany } from "@/lib/house";
import { companyHref, decodeParam, investorHref, investorHrefByName } from "@/lib/links";
import { SECTION_INDEX_TITLE } from "@/lib/news";
import { canonicalBase, canonicalUrl } from "@/lib/origin";
import { type RoundRow, toAlexandria, toFeedRow } from "@/lib/persist";
import { pricingModelLabel, pricingView } from "@/lib/pricing";
import { loadPublisherTiers } from "@/lib/rules";
import { asOfSentence, companyJsonLd, companySearchMeta, fundingSummary, pendingClause, raisedFigure, verifiedRaise } from "@/lib/seo";
import { companyShare, shareMetadata } from "@/lib/share";
import { capitalizeFirst } from "@/lib/text";
import { cn } from "@/lib/utils";

/** The profile rewrite reads the company's site inline; give it room on serverless hosts. Deep dive only starts a workflow. */
export const maxDuration = 300;

// The body defers behind Suspense, so metadata for a live id streams in with it; a miss keeps "Company".
// Link unfurlers (Slackbot and co.) get it blocking in <head>. The card is the colocated opengraph-image.
export async function generateMetadata({ params }: PageProps<"/companies/[id]">): Promise<Metadata> {
  const { id } = await params;
  // The visitor's view, from the shared cache the body reads too (lib/cached.ts).
  const page = (await cachedCompanyView(decodeParam(id)))?.page;
  if (!page) return { title: "Company" };
  const share = companyShare(page);
  // A search result answers the query people type ("Ramp funding rounds and investors", "How much has
  // Ramp raised?") from the verified rounds; the unfurl keeps the share card's latest-round title. The
  // canonical is the stored id, however the URL spelled it.
  const search = companySearchMeta(page, share.description);
  const meta = shareMetadata({ title: share.title, description: share.description });
  const url = canonicalUrl(companyHref(page.company.id));
  // The same page as markdown for agents (lib/llms.ts), beside the feed links every page carries.
  const markdown = [{ url: `${companyHref(page.company.id)}/index.md`, title: `${page.company.name} (Markdown)` }];
  return {
    ...meta,
    title: search.title,
    description: search.description,
    alternates: { canonical: url, types: { ...feedAlternateTypes(), "text/markdown": markdown } },
    openGraph: { ...meta.openGraph, url },
  };
}

const DESCRIPTION = "Every round on record, with the sources behind each and the investors on them.";

/** Index into NAV for the Companies entry, so the sidebar lights it on a company page. */
const SECTION = 7;

function Crumbs({ current }: { current?: string }) {
  return (
    <>
      <Link href="/feed" className="hover:text-foreground">
        Feed
      </Link>
      <span className="mx-1.5 text-black-alpha-24 dark:text-white/20">/</span>
      <Link href="/companies" className="hover:text-foreground">
        Companies
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

/** What opens under a round: the verifier's verdict, score and notes, then the Built with strip. */
function RoundProof({ r, readOnly, dossier, xPeople }: { r: RoundRow; readOnly: boolean; dossier: boolean; xPeople: number }) {
  return (
    <>
      <p className="text-mono-x-small text-muted-foreground">
        {r.sources.length} {r.sources.length === 1 ? "source" : "sources"}
        {r.verification_checks?.attempts ? (
          <>
            {" "}
            · checked {r.verification_checks.attempts} {r.verification_checks.attempts === 1 ? "time" : "times"}, last{" "}
            <RelativeCheck iso={r.verification_checks.last_checked_at} />
          </>
        ) : null}
      </p>
      <RoundCertaintyDetail r={r} />
      {/* The verdict renders in the browser: toFeedRow leaves the verifier's model and the search text behind. */}
      <Verified r={toFeedRow(r)} readOnly={readOnly} />
      <BuiltWith r={r} dossier={dossier} xPeople={xPeople} />
    </>
  );
}

/**
 * The Round cell's check line: the source count, which opens how the round was verified, and for an
 * admin the word for a round off the feed (REVIEW, REJECTED). A round on the feed, published or
 * flagged, wears no status word.
 */
function RoundCheckLine({ r, className }: { r: RoundRow; className?: string }) {
  return (
    <div className={className ?? "mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1"}>
      <RoundFoldToggle>
        <RoundCheckMark r={r} />
      </RoundFoldToggle>
      <DispositionTag value={r.disposition} />
      <HistoryMark history={r.history} reportedLater={r.hold?.startsWith("reported later:")} />
      <RoundCertainty r={r} />
    </div>
  );
}

/** "Seed ext." for the latest-round card. */
function roundName(r: RoundRow): string {
  return `${roundStageLabel(r)}${r.is_extension ? " ext." : ""}`;
}

/** Over the dossier's prior rounds that match none on record: listed with the rounds, told apart from them. */
const PRIORS_HEADING = "EARLIER ROUNDS FROM COMPANY RESEARCH · DEVELOPING";
const REQUESTED_PRIORS_HEADING = "EARLIER ROUNDS FROM COMPANY RESEARCH · NOT VERIFIED";

/** A round's sources and investors show this many before the rest fold behind a toggle. */
const SOURCES_SHOWN = 3;
const INVESTORS_SHOWN = 6;

/**
 * The heading over one round's sources or investors: the stage, the amount, and the date, then how
 * many sit under it. An admin also sees the status word on a round off the feed.
 */
function RoundHeading({ r, count, noun }: { r: RoundRow; count: number; noun: [string, string] }) {
  const amount = reportedAmount(r);
  return (
    <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border-faint pb-1.5 text-body-small">
      <span className="text-label-small">{roundName(r)}</span>
      {amount && <span className="text-mono-small">{amount}</span>}
      <span className="text-mono-small text-muted-foreground" title={precisionNote(r.date_precision) ?? undefined}>
        {approxDate(r.announced_on, r.date_precision)}
      </span>
      <DispositionTag value={r.disposition} />
      <span className="ml-auto whitespace-nowrap text-muted-foreground">
        <span className="text-mono-small">{count}</span> {count === 1 ? noun[0] : noun[1]}
      </span>
    </h3>
  );
}

async function CompanyBody({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const v = await viewer();
  // An admin also sees the rows in review and rejected, each wearing its status, read fresh; a demo
  // visitor, only the feed's, from one shared cache entry a minute (lib/cached.ts).
  const companyId = decodeParam(id);
  let view = seesReview(v) ? await readCompanyView(await db(), companyId, true) : await cachedCompanyView(companyId);
  // A requested company lives at its domain from submission: the research state until it is done,
  // then the company itself, read fresh once so a cached miss from before it finished never shows.
  const request = process.env.COMPANY_REQUESTS === "1" ? await companyRequestFor(await db(), companyId) : null;
  if (request) {
    if (request && request.status !== "done" && !view?.page.rounds.length) {
      return (
        <>
          <PageHeader
            section={SECTION}
            title={request.domain}
            description="Company research"
            breadcrumb={<Crumbs current={request.domain} />}
          />
          <PageBody width="narrow">
            <RequestProgress
              initial={publicRequestStatus({
                ...request,
                tally:
                  request.status === "running" && request.companyId ? await requestTally(await db(), request.companyId) : request.tally,
              })}
            />
          </PageBody>
        </>
      );
    }
    // Just finished, or its dossier still adding rounds: read fresh, so a cached page from a minute ago never hides them.
    const settling =
      request.dossierStatus === "running" ||
      (request.dossierFinishedAt !== null && Date.now() - request.dossierFinishedAt.getTime() < 5 * 60_000);
    if (request.status === "done" && (!view || (settling && !seesReview(v)))) {
      view = await readCompanyView(await db(), companyId);
      if (!view && request.companyId && request.companyId !== companyId) redirect(companyHref(request.companyId));
    }
  }
  const dossierRunning = request?.status === "done" && request.dossierStatus === "running";
  if (!view) {
    // A folded company's old id (a link a Slack delivery already sent) goes to the row it was folded into.
    const survivor = await companyRedirect(await db(), companyId);
    if (survivor?.permanent) permanentRedirect(companyHref(survivor.id));
    if (survivor) redirect(companyHref(survivor.id));
    notFound();
  }
  const { page, onX, buzz, ruledOut } = view;
  const { company, rounds, enrichment, alexandria, dossier, sources, investors, totals } = page;
  const plans = pricingView(enrichment?.plans ?? []);
  const pricingModel = pricingModelLabel(enrichment?.pricing_model);
  // What the Trending lane read on X for these rounds (onX above): the "On X" block, the Built with
  // strip's X step, and the Buzz column (a round in its 72 hours; the rest are empty).
  const xPeople = new Map(onX.map((x) => [x.round_id, x.people]));
  // A demo visitor sees no control that writes or spends: no profile rewrite, no Deep dive, no dossier Refresh.
  const readOnly = v.demo && !v.admin;
  // The company this feed is built on (lib/house.ts) wears the flame and says so in its header card.
  const house = isHouseCompany(company);
  const yc = alexandria?.yc.status === "matched" ? alexandria.yc : null;
  // Founded and headcount read once, in the header line: YC's founding year when it can be true, else
  // the checked dossier's; the dossier's team size, else YC's application-time figure.
  const facts = companyFacts(toAlexandria(alexandria ?? undefined)?.yc, dossier?.verification ? dossier.data : null, page.linkedin_url);
  const chips = factChips(yc, facts);
  // One founders list: the dossier's people with YC's LinkedIn links, or YC's alone. It sits in the
  // dossier when there is one, else in the Profile panel.
  const founders = mergeFounders(dossier?.data.founders ?? [], yc?.founders ?? []);
  const foundersVia = yc?.url ?? null;
  // What the dossier names that the record does not: backers no investor covers, rounds no round covers.
  const backersOnlyInDossier = dossier
    ? unlistedBackers(
        dossier.data.investors_and_backers,
        investors.map((i) => i.name),
      )
    : [];
  // A prior with nothing but its stage ("Seed", no amount, day, or lead) says nothing a reader can use.
  const priorsOnlyInDossier = dossier
    ? priorsOffRecord(dossier.data.prior_rounds, rounds, ruledOut).filter(
        (p) => p.amount_as_written || p.announced_date || p.lead_investors.length > 0,
      )
    : [];
  // A requested company says why each of those is not on the page yet, instead of a blanket "developing".
  const priorsHeading = page.priorReasons ? REQUESTED_PRIORS_HEADING : PRIORS_HEADING;
  const priorNote = (p: (typeof priorsOnlyInDossier)[number]) =>
    page.priorReasons ? (page.priorReasons[priorKey(p)] ?? STILL_CHECKING) : null;
  // Sources and investors under the round each belongs to, newest round first; syndicated copies
  // fold to one entry per wire title within a round.
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const sourceGroups = sourcesByRound(rounds, sources, tiers);
  const investorGroups = investorsByRound(rounds, investors);

  // The stat row answers what a reader asks first: the latest round, the money, who is on it, how sourced.
  // The counts cover the feed's rounds (publish, flagged); the money counts only the verified ones
  // (lib/seo.ts verifiedRaise), the same figure the dated summary states, so the page never shows two totals.
  const counted = rounds.filter(inFeed);
  const offFeed = rounds.length - counted.length;
  const latest = counted[0] ?? null;
  const raise = verifiedRaise(rounds);
  const stated = raise.priced.length;
  const pending = pendingClause(raise.pending);
  // Funding to date a verified round's page stated beyond those rounds: the gap said at the figure, not only in the research panel.
  const reportedTotal = Math.max(0, ...raise.cited.map((r) => totalToDate(r) ?? 0));
  const beyondRecord = reportedTotal > raise.usdMillions * 1.02 ? `${usd(reportedTotal)} to date, as reported` : null;
  const leads = investors.filter((i) => i.leads > 0).length;
  const publishers = new Set(sources.map((s) => hostLabel(s.host))).size;
  // A round on the feed announced after the dossier was written: the dossier cannot know it.
  const newer = dossier ? roundAfter(counted, dossier.fetched_at) : null;
  const dossierPredates = newer ? `${roundName(newer)} of ${approxDate(newer.announced_on, newer.date_precision)}` : null;
  // A requested company research could not verify a round for: no empty figures or lists, one panel on why.
  const requestedEmpty = page.addedOnRequest && rounds.length === 0;
  // The answer a search or an assistant quotes, dated: "As of 13 Oct 2026, Ramp has raised …".
  const summary = fundingSummary(company.name, rounds);
  const asOf = new Date();

  // One quiet line under the description: where to find it, where it is, and the sourced facts.
  const meta: Array<{ key: string; node: ReactNode }> = [];
  if (company.website)
    meta.push({
      key: "site",
      node: (
        <a href={company.website} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
          {company.domain ?? company.website}
        </a>
      ),
    });
  if (facts.linkedin_url)
    meta.push({
      key: "linkedin",
      node: (
        <a
          href={facts.linkedin_url}
          title={LINKEDIN_TITLE}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          LinkedIn
        </a>
      ),
    });
  if (company.hq) meta.push({ key: "hq", node: company.hq });
  if (company.sector) meta.push({ key: "sector", node: sectorLabel(company.sector) });
  for (const f of chips) {
    // The chips arrive lowercase for the feed's inline row; a header line reads in sentence case.
    meta.push({ key: f.label, node: <span title={f.title}>{f.label.charAt(0).toUpperCase() + f.label.slice(1)}</span> });
  }
  // Beside Founded when there is one: a listed company keeps its page and the private rounds before its listing.
  if (page.publicListing) {
    const founded = meta.findIndex((m) => m.key.startsWith("founded"));
    meta.splice(founded >= 0 ? founded + 1 : meta.length, 0, {
      key: "public",
      node: <span title={`Listed: ${page.publicListing}`}>Public company</span>,
    });
  }

  // YC's founders sit in the Profile only when there is no dossier to carry them.
  const foundersInProfile = !dossier && founders.length > 0;
  // The site's own words on what it sells, unless the dossier's one-liner already says it above.
  const showDoes = Boolean(enrichment?.verified && enrichment.what_they_sell && !dossier?.data.one_liner);
  const profileRows =
    showDoes ||
    (enrichment?.verified && (pricingModel || enrichment.has_free_tier || plans.rows.length > 0 || enrichment.pricing_page_url)) ||
    foundersInProfile;
  // A homepage that failed the identity check wrote nothing: an admin reads why, a visitor gets no
  // empty panel explaining the pipeline. The bracket codes are pipeline states, so they are admin-only too.
  const failedProfile = Boolean(enrichment && !enrichment.verified);
  const hasProfile = Boolean(profileRows || (failedProfile && !readOnly));
  const profileCode = readOnly ? undefined : enrichment?.verified ? "ENRICHED" : enrichment ? "UNVERIFIED" : "ALEXANDRIA";

  const dossierPanel = dossier ? (
    <DossierPanel
      companyId={company.id}
      dossier={dossier}
      canRefresh={!readOnly}
      founders={founders}
      foundersVia={foundersVia}
      total={dossierTotal(dossier.data.total_raised_as_written, counted, stated ? raise.usdMillions : null, dossier.fetched_at)}
      predates={dossierPredates}
    />
  ) : null;
  // With a dossier the Profile is a fact card in the rail; without one it is what the company is, so it
  // leads the wide column and the rail keeps to who invested.
  const profilePanel = hasProfile ? (
    <Panel title="Profile" code={profileCode} className="order-2 lg:order-none">
      {failedProfile && !readOnly && (
        <div className="mb-3 space-y-2 border-b border-border-faint pb-3 text-body-small text-muted-foreground last:mb-0 last:border-0 last:pb-0">
          <p>No homepage passed the identity check, so nothing was written. Refresh profile tries again with what the record now knows.</p>
          {enrichment?.error && <p className="break-words">{enrichment.error}</p>}
        </div>
      )}
      {profileRows && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body-small">
          {showDoes && (
            <>
              <dt className="text-muted-foreground">Does</dt>
              <dd>{capitalizeFirst(enrichment?.what_they_sell)}</dd>
            </>
          )}
          {enrichment?.verified && (pricingModel || (enrichment.has_free_tier && !plans.showsFree)) && (
            <>
              <dt className="text-muted-foreground">Pricing</dt>
              <dd>
                {pricingModel}
                {/* A Free row already says it; the tag covers a free tier the plan list does not show. */}
                {enrichment.has_free_tier && !plans.showsFree ? (
                  <span className="text-muted-foreground">{pricingModel ? " · free tier" : "Free tier"}</span>
                ) : null}
              </dd>
            </>
          )}
          {enrichment?.verified && plans.rows.length > 0 && (
            <>
              <dt className="text-muted-foreground">Plans</dt>
              <dd className="min-w-0">
                <PricingPlans plans={enrichment.plans} limit={6} />
              </dd>
            </>
          )}
          {enrichment?.verified && enrichment.pricing_page_url && (
            <>
              <dt className="text-muted-foreground">Pricing page</dt>
              <dd className="min-w-0">
                <a
                  href={enrichment.pricing_page_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 hover:underline"
                >
                  <span className="truncate">{hostOf(enrichment.pricing_page_url) || enrichment.pricing_page_url}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              </dd>
            </>
          )}
          {foundersInProfile && (
            <>
              <dt className="text-muted-foreground">Founders</dt>
              <dd className="min-w-0">
                <FounderList founders={founders} via={null} />
              </dd>
            </>
          )}
        </dl>
      )}
      {foundersInProfile && yc && (
        <p className="mt-3 border-t border-border-faint pt-3 text-body-small text-muted-foreground">
          Via Alexandria founders from{" "}
          <a href={yc.url} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
            ycombinator.com
          </a>
        </p>
      )}
    </Panel>
  ) : null;

  return (
    <>
      {/* The structured data and the summary keep to the verified, published rounds whoever renders the page. */}
      <JsonLd data={companyJsonLd(page, canonicalBase(), asOf)} />
      <TrackView event="fireround_company_viewed" properties={{ company: company.id, stage: latest?.stage ?? "none" }} />
      <PageHeader
        section={SECTION}
        title={company.name}
        description={summary ? asOfSentence(summary, asOf) : DESCRIPTION}
        breadcrumb={<Crumbs current={company.name} />}
        actions={
          <>
            {company.website && (
              <Button asChild variant="outline" size="sm">
                <a href={company.website} target="_blank" rel="noreferrer">
                  Visit site <ExternalLink className="size-3.5" />
                </a>
              </Button>
            )}
            {!readOnly && <RefreshProfileButton companyId={company.id} />}
            {!readOnly && !dossier && <DeepDiveButton companyId={company.id} />}
          </>
        }
      />
      <PageBody>
        {/* The page title already names the company, so the card leads with what it does. */}
        <div className="relative flex items-start gap-4 overflow-hidden rounded-12 border border-border-faint bg-card p-5 sm:gap-5 sm:p-6">
          {house && <span className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-heat-64 via-heat-16 to-transparent" aria-hidden />}
          {house ? (
            <FlameMark live size="inherit" className="size-12" />
          ) : (
            <CompanyLogo
              id={company.id}
              name={company.name}
              domain={company.domain}
              logoUrl={company.logo_url}
              size={48}
              className="mt-0.5"
            />
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-body-medium">
              {capitalizeFirst(company.description) ?? <span className="text-muted-foreground">No description yet.</span>}
            </p>
            {meta.length > 0 && (
              <p className="text-body-small text-muted-foreground">
                {meta.map((m, i) => (
                  <Fragment key={m.key}>
                    {i > 0 && <Dot />}
                    <span className="whitespace-nowrap">{m.node}</span>
                  </Fragment>
                ))}
              </p>
            )}
            {process.env.COMPANY_REQUESTS === "1" && <RequestProvenance addedOnRequest={page.addedOnRequest} />}
            {dossierRunning && request && <DossierPending id={request.id} />}
            {process.env.COMPANY_REQUESTS === "1" && page.addedOnRequest && (
              <RequestViewed keys={[company.id, company.domain].filter((k): k is string => Boolean(k))} />
            )}
            {house && (
              <p className="border-t border-border-faint pt-2.5 text-body-small text-muted-foreground">
                SignalRound uses native web search and page reading. Structured research uses your configured model provider.
              </p>
            )}
          </div>
        </div>

        {!requestedEmpty && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {latest ? (
              <Stat
                label="LATEST ROUND"
                value={roundName(latest)}
                hint={[
                  reportedAmount(latest) ?? "amount not stated",
                  latest.announced_on ? approxDate(latest.announced_on, latest.date_precision) : "undated",
                  certaintyLabel(latest)?.toLowerCase(),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ) : (
              <Stat label="ROUNDS ON RECORD" value={totals.rounds} hint={`${offFeed} off the feed`} />
            )}
            <Stat
              label="RAISED ON RECORD · USD"
              value={raise.cited.length === 0 ? "None" : stated ? raisedFigure(raise.usdMillions) : "Undisclosed"}
              hint={[
                raise.cited.length === 0
                  ? counted.length === 0
                    ? "none on record"
                    : "no verified round yet"
                  : stated === 0
                    ? raise.cited.some((r) => r.financing_total_as_written)
                      ? "no isolated primary amount"
                      : "no verified round states an amount"
                    : stated === raise.cited.length
                      ? beyondRecord
                        ? `${stated} verified ${stated === 1 ? "round" : "rounds"}`
                        : `across ${stated} verified ${stated === 1 ? "round" : "rounds"}`
                      : `${stated} of ${raise.cited.length} verified rounds state an amount`,
                beyondRecord,
                pending && `plus ${pending}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            {investors.length > 0 || !latest ? (
              // With no feed round the first card already says so; this one counts who is named on them.
              <Stat
                label="INVESTORS"
                value={investors.length}
                hint={investors.length === 0 ? "none named" : leads === 0 ? "no lead named" : `${leads} ${leads === 1 ? "lead" : "leads"}`}
              />
            ) : (
              <Stat
                label="ROUNDS ON RECORD"
                value={totals.rounds}
                hint={`${counted.filter((r) => r.disposition === "publish").length} published`}
              />
            )}
            <Stat label="SOURCES" value={sources.length} hint={`from ${publishers} ${publishers === 1 ? "publisher" : "publishers"}`} />
          </div>
        )}

        {requestedEmpty ? (
          <div className="space-y-6">
            {profilePanel}
            <RequestFundingHistory tally={page.requestTally} dossierRunning={dossierRunning} />
            {dossierPanel}
          </div>
        ) : (
          <>
            <Panel title="Rounds" code={String(rounds.length)} flush>
              {offFeed > 0 && (
                <p className="border-b border-border-faint px-5 py-2.5 text-body-small text-muted-foreground">
                  {offFeed === 1 ? "One round is" : `${offFeed} rounds are`} in review or rejected: listed here for admins, left out of the
                  figures above and the feed.
                </p>
              )}
              {rounds.length === 0 && priorsOnlyInDossier.length === 0 && (
                <p className="px-5 py-4 text-body-small text-muted-foreground">No funding rounds verified for this company.</p>
              )}
              {/* Below md the five columns have nowhere to go: each round is a block, verification beneath it. */}
              <div
                className={cn(
                  "divide-y divide-border-faint text-body-small md:hidden",
                  rounds.length === 0 && priorsOnlyInDossier.length === 0 && "hidden",
                )}
              >
                {rounds.map((r) => (
                  <RoundFold as="div" key={r.id} className="flex flex-col gap-3 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-label-medium">
                          {roundStageLabel(r)}
                          {r.is_extension && <span className="font-normal text-muted-foreground"> ext.</span>}
                          {stageAsWrittenNote(r) && (
                            <span className="ml-2 text-body-small font-normal text-muted-foreground">{stageAsWrittenNote(r)}</span>
                          )}
                        </div>
                        <div className="mt-1 text-mono-small">
                          {reportedAmount(r) ? reportedAmount(r) : <span className="text-muted-foreground">n/a</span>}
                          <span className="text-black-alpha-32 dark:text-muted-foreground"> · </span>
                          {r.announced_on ? (
                            <span title={precisionNote(r.date_precision) ?? undefined}>{approxDate(r.announced_on, r.date_precision)}</span>
                          ) : (
                            <span className="text-muted-foreground">undated</span>
                          )}
                        </div>
                        {r.valuation && (
                          <div className="text-body-small text-muted-foreground">at {valuationLabel(r.valuation)} valuation</div>
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <RoundCheckLine r={r} className="contents" />
                          <BuzzInline mark={buzz.marks[r.id]} scale={buzz.scale} />
                        </div>
                        <div className="mt-1 text-body-small text-muted-foreground">
                          {r.lead_investors.length === 0 ? (
                            "lead not stated"
                          ) : (
                            <>
                              led by{" "}
                              {r.lead_investors.map((name, i) => (
                                <span key={name}>
                                  {i > 0 && ", "}
                                  <Link
                                    href={investorHrefByName(name)}
                                    className="text-foreground underline decoration-black-alpha-32 underline-offset-2 hover:decoration-current"
                                  >
                                    {name}
                                  </Link>
                                </span>
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <RoundFoldPanel>
                      <RoundProof r={r} readOnly={readOnly} dossier={dossier !== null} xPeople={xPeople.get(r.id) ?? 0} />
                    </RoundFoldPanel>
                  </RoundFold>
                ))}
                {priorsOnlyInDossier.length > 0 && (
                  <div className="space-y-1.5 px-5 py-4 text-muted-foreground">
                    <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">{priorsHeading}</div>
                    {priorsOnlyInDossier.map((p) => (
                      <div key={`${p.stage_as_written}-${p.announced_date}`}>
                        {capitalizeFirst(p.stage_as_written)}
                        <span className="text-mono-small">
                          {" · "}
                          {p.amount_as_written ?? "n/a"} · {p.announced_date ?? "undated"}
                        </span>
                        {p.lead_investors.length > 0 && <div>led by {p.lead_investors.join(", ")}</div>}
                        {priorNote(p) && <div>{priorNote(p)}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <table
                className={cn(
                  "hidden w-full table-fixed text-body-small md:table",
                  rounds.length === 0 && priorsOnlyInDossier.length === 0 && "md:hidden",
                )}
              >
                <thead className="text-left text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
                  <tr className="border-b border-border-faint">
                    <th className="w-40 py-2.5 pl-5 font-normal">Round</th>
                    <th className="w-32 py-2.5 text-right font-normal lg:w-52">Amount</th>
                    <th className="w-32 py-2.5 pl-6 font-normal">Announced</th>
                    <th className="py-2.5 pl-6 font-normal">Lead</th>
                    <th className="w-36 py-2.5 pr-5 pl-6 text-right font-normal">Buzz</th>
                  </tr>
                </thead>
                {rounds.map((r) => (
                  // Each round is its own <tbody>: the check mark in the row and the panel under it share one fold.
                  <RoundFold key={r.id} className="border-b border-border-faint last:border-0">
                    <tr>
                      <td className="py-3 pl-5 align-top text-label-medium">
                        {roundStageLabel(r)}
                        {r.is_extension && <span className="font-normal text-muted-foreground"> ext.</span>}
                        {/* The words as written, when they say more than the stage: "Series A" under Series A is a wasted line. */}
                        {stageAsWrittenNote(r) && (
                          <div className="truncate text-body-small font-normal text-muted-foreground" title={r.stage_as_written}>
                            {stageAsWrittenNote(r)}
                          </div>
                        )}
                        <RoundCheckLine r={r} />
                      </td>
                      <td className="py-3 text-right align-top">
                        {reportedAmount(r) ? (
                          <>
                            <div className="text-mono-small">{reportedAmount(r)}</div>
                            {r.amount.as_written && r.financing_total_as_written && (
                              <div className="whitespace-nowrap text-body-small text-muted-foreground">
                                {totalToDate(r) !== null
                                  ? `${/^(?:approximately|about|around|roughly)\b/i.test(r.financing_total_as_written ?? "") ? "~" : ""}${usd(totalToDate(r))} to date`
                                  : reportedAmount({ ...r, amount: { as_written: null, usd_millions: null } })?.replace(
                                      /^(?:approximately|about|around|roughly)\s+/i,
                                      "~",
                                    )}
                              </div>
                            )}
                            {r.amount.usd_millions !== null && r.amount.currency !== "USD" && (
                              <div className="text-body-small text-muted-foreground">{r.amount.as_written}</div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">n/a</span>
                        )}
                        {r.valuation && (
                          <div className="text-body-small text-muted-foreground">at {valuationLabel(r.valuation)} valuation</div>
                        )}
                      </td>
                      <td className="py-3 pl-6 align-top text-mono-small">
                        {r.announced_on ? (
                          <span title={precisionNote(r.date_precision) ?? undefined}>{approxDate(r.announced_on, r.date_precision)}</span>
                        ) : (
                          <span className="font-normal text-muted-foreground">undated</span>
                        )}
                      </td>
                      <td className="py-3 pl-6 align-top">
                        {r.lead_investors.length === 0 ? (
                          <span className="text-muted-foreground">not stated</span>
                        ) : (
                          r.lead_investors.map((name, i) => (
                            <span key={name}>
                              {i > 0 && ", "}
                              <Link href={investorHrefByName(name)} className="hover:underline">
                                {name}
                              </Link>
                            </span>
                          ))
                        )}
                      </td>
                      <td className="py-3 pr-5 pl-6 align-top">
                        <Buzz mark={buzz.marks[r.id]} scale={buzz.scale} />
                      </td>
                    </tr>
                    <RoundFoldPanel colSpan={5}>
                      <RoundProof r={r} readOnly={readOnly} dossier={dossier !== null} xPeople={xPeople.get(r.id) ?? 0} />
                    </RoundFoldPanel>
                  </RoundFold>
                ))}
                {priorsOnlyInDossier.length > 0 && (
                  <tbody>
                    <tr>
                      <td colSpan={5} className="px-5 pt-3 pb-1 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
                        {priorsHeading}
                      </td>
                    </tr>
                    {priorsOnlyInDossier.map((p) => (
                      <tr key={`${p.stage_as_written}-${p.announced_date}`} className="text-muted-foreground [&:last-child>td]:pb-3">
                        <td className="py-1.5 pl-5 align-top">{capitalizeFirst(p.stage_as_written)}</td>
                        <td className="py-1.5 text-right align-top text-mono-small">{p.amount_as_written ?? "n/a"}</td>
                        <td className="py-1.5 pl-6 align-top text-mono-small">{p.announced_date ?? "undated"}</td>
                        <td colSpan={priorNote(p) ? 1 : 2} className="py-1.5 pr-5 pl-6 align-top">
                          {p.lead_investors.length > 0 ? p.lead_investors.join(", ") : "not stated"}
                        </td>
                        {priorNote(p) && <td className="py-1.5 pr-5 pl-6 text-right align-top">{priorNote(p)}</td>}
                      </tr>
                    ))}
                  </tbody>
                )}
              </table>
              {page.addedOnRequest && <AlsoFound tally={page.requestTally} rounds={rounds} />}
            </Panel>

            <OnX rounds={onX} labels={new Map(rounds.map((r) => [r.id, roundName(r)]))} admin={!readOnly} />

            {/*
          Below the rounds, two columns that each stack on their own: what the company is (the dossier,
          else the profile) and its sources on the left, the investors on the right, beside the profile
          when a dossier has the left. A long investor list only lengthens the rail; it never pushes the
          next panel down past it. Below lg the columns dissolve (contents) into one stack ordered by what
          a reader wants next: the dossier, the profile, who invested, then the sources.
        */}
            <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:items-start">
              <div className="contents lg:col-span-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
                {dossier && <div className="order-1 min-w-0 lg:order-none">{dossierPanel}</div>}
                {!dossier && profilePanel}
                <Panel title="Sources" code={String(sources.length)} className="order-4 lg:order-none">
                  {sourceGroups.length === 0 ? (
                    <p className="text-body-small text-muted-foreground">No sources on record.</p>
                  ) : (
                    <div className="space-y-5">
                      {sourceGroups.map(({ round, entries, count }) => (
                        <section key={round.id} className="space-y-2">
                          <RoundHeading r={round} count={count} noun={["source", "sources"]} />
                          <ShowMore
                            className="space-y-2.5"
                            initial={SOURCES_SHOWN}
                            more={`Show all ${count} sources`}
                            less="Show fewer sources"
                            items={entries.map(({ primary: s, also }) => (
                              <li key={s.url}>
                                {/* The title leads; the publisher and day sit at the right edge, under the title on a phone. */}
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="group flex items-start gap-2 text-body-small"
                                  {...trackClick("fireround_source_clicked", { location: "company", source_host: hostLabel(s.host) })}
                                >
                                  <ExternalLink className="mt-1 size-3 shrink-0 text-muted-foreground" aria-hidden />
                                  <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                                    <span className="min-w-0 break-words">
                                      <span className="group-hover:underline">
                                        {s.title && SECTION_INDEX_TITLE.test(s.title)
                                          ? `${hostLabel(s.host)} press release`
                                          : (s.title ?? s.url)}
                                      </span>
                                      {also.length > 0 && (
                                        <span className="block text-muted-foreground">
                                          also on {[...new Set(also.map((a) => hostLabel(a.host)))].join(", ")}
                                        </span>
                                      )}
                                    </span>
                                    <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                                      {hostLabel(s.host)} · <RelativeDay iso={s.published_at} />
                                    </span>
                                  </span>
                                </a>
                              </li>
                            ))}
                          />
                        </section>
                      ))}
                    </div>
                  )}
                </Panel>
              </div>

              <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
                {dossier && profilePanel}
                <Panel title="Investors" code={String(investors.length)} className="order-3 lg:order-none">
                  {investorGroups.length === 0 ? (
                    <p className="text-body-small text-muted-foreground">None named.</p>
                  ) : (
                    <div className="space-y-5">
                      {investorGroups.map(({ round, leads, participants }) => {
                        const all = [...leads.map((i) => ({ i, lead: true })), ...participants.map((i) => ({ i, lead: false }))];
                        return (
                          <section key={round.id} className="space-y-2">
                            <RoundHeading r={round} count={all.length} noun={["investor", "investors"]} />
                            <ShowMore
                              className="space-y-1.5 text-body-small"
                              initial={INVESTORS_SHOWN}
                              more={`+${all.length - INVESTORS_SHOWN} more`}
                              less="Show fewer"
                              items={all.map(({ i, lead }) => (
                                <li key={i.id} className="flex min-w-0 items-center gap-2">
                                  <InvestorLogo id={i.id} name={i.name} domain={i.domain} logoUrl={i.logo_url} size={20} />
                                  <IntentLink href={investorHref(i.id)} className="truncate hover:underline">
                                    {i.name}
                                  </IntentLink>
                                  {lead && <RoleTag lead />}
                                </li>
                              ))}
                            />
                          </section>
                        );
                      })}
                    </div>
                  )}
                  {/* The dossier's backers no round names, said once here rather than as a second list in the dossier. */}
                  {backersOnlyInDossier.length > 0 && (
                    <p className="mt-4 border-t border-border-faint pt-3 text-body-small text-muted-foreground">
                      Also named as backers in company research: <span className="text-foreground">{backersOnlyInDossier.join(", ")}</span>
                    </p>
                  )}
                </Panel>
              </div>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

export default function CompanyPage({ params }: PageProps<"/companies/[id]">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader section={SECTION} title="Company" description={DESCRIPTION} breadcrumb={<Crumbs />} />
          <PageBody>
            <HeaderCardSkeleton />
            <StatRowSkeleton />
            <PanelSkeleton title="Rounds" flush>
              <TableSkeleton
                rows={2}
                logo={false}
                bar={false}
                className="rounded-none border-0"
                cols={["w-24 text-right", "w-28", "hidden w-64 lg:block", "w-16 text-right", "w-24", "w-16 text-right"]}
              />
            </PanelSkeleton>
            <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:items-start">
              <div className="lg:col-span-2">
                <PanelSkeleton title="Sources">
                  <ListSkeleton rows={4} logo={false} trailing={[]} />
                </PanelSkeleton>
              </div>
              <div className="flex flex-col gap-6">
                <PanelSkeleton title="Profile">
                  <SkeletonLine width="w-full" />
                  <SkeletonLine width="w-full" />
                  <SkeletonLine width="w-2/3" />
                </PanelSkeleton>
                <PanelSkeleton title="Investors">
                  <ListSkeleton rows={4} logo={false} trailing={[]} />
                </PanelSkeleton>
              </div>
            </div>
          </PageBody>
        </>
      }
    >
      <CompanyBody params={params} />
    </Suspense>
  );
}
