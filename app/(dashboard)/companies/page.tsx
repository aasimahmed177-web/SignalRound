import { connection } from "next/server";
import { Suspense } from "react";
import { CompanyEmptyState } from "@/components/company/company-empty-state";
import { CompanyRequestCallout } from "@/components/company/company-request-callout";
import { RequestCompanyDialog } from "@/components/company/request-company-dialog";
import { YourRequests } from "@/components/company/your-requests";
import { CompanyLogo } from "@/components/company-logo";
import { Pager } from "@/components/feed/pager";
import { DirectoryControls } from "@/components/search/directory-controls";
import { IntentLink } from "@/components/shell/intent-link";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { PillSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { cachedCompanies } from "@/lib/cached";
import { shouldSuggestCompany, websiteFromQuery } from "@/lib/company-request-ui";
import { db } from "@/lib/db";
import {
  COMPANY_SORTS,
  type CompanyListing,
  DIRECTORY_PAGE_SIZE,
  directoryHref,
  hasNamedCompanyInResults,
  parseDirectoryParams,
} from "@/lib/directory";
import { approxDate, precisionNote, roundStageLabel, sectorLabel, usd } from "@/lib/format";
import { companyHref } from "@/lib/links";
import { shareMetadata } from "@/lib/share";
import { capitalizeFirst, groupDigits } from "@/lib/text";
import { cn } from "@/lib/utils";

type Search = Record<string, string | string[] | undefined>;

const SORTS = [
  { value: "", label: "Latest round" },
  { value: "raised", label: "Raised on record" },
  { value: "name", label: "Name" },
];

const muted = "text-black-alpha-56 dark:text-muted-foreground";
const faint = "text-black-alpha-32 dark:text-muted-foreground";
const none = "text-black-alpha-32";

function Raised({ c }: { c: CompanyListing }) {
  return c.usd_millions_raised ? usd(c.usd_millions_raised) : <span className={none}>n/a</span>;
}

function Latest({ c }: { c: CompanyListing }) {
  if (!c.latest) return <span className={none}>n/a</span>;
  return (
    <>
      <span>{roundStageLabel(c.latest)}</span>{" "}
      <span className={cn("text-mono-small font-normal", muted)} title={precisionNote(c.latest.date_precision) ?? undefined}>
        {approxDate(c.latest.announced_on, c.latest.date_precision)}
      </span>
    </>
  );
}

function roundsLabel(n: number): string {
  return `${n} ${n === 1 ? "round" : "rounds"}`;
}

/** Below md: one card per company. At md and up: the table. Both render and CSS picks one, as the feed does. */
function CompaniesList({ rows }: { rows: CompanyListing[] }) {
  const head = "py-2.5 text-left font-normal";
  const cell = "py-3 align-top";
  return (
    <>
      <ul className="divide-y divide-border-faint text-body-small md:hidden">
        {rows.map((c) => (
          <li key={c.id} className="relative flex items-start gap-3 px-4 py-3 hover:bg-black-alpha-4 dark:hover:bg-white/4">
            <CompanyLogo id={c.id} name={c.name} domain={c.domain} logoUrl={c.logo_url} size={32} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              {/* The name's ::after covers the card, so a tap anywhere opens the company. */}
              <IntentLink href={companyHref(c.id)} className="block truncate text-label-medium after:absolute after:inset-0">
                {c.name}
              </IntentLink>
              <div className={cn("truncate", muted)}>{capitalizeFirst(c.description) ?? c.domain ?? sectorLabel(c.sector)}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-mono-small">
                  <Raised c={c} />
                </span>
                <span className={muted}>{roundsLabel(c.rounds)}</span>
                <span className="min-w-0">
                  <Latest c={c} />
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <table className="hidden w-full table-fixed text-body-small md:table">
        <thead className={cn("text-mono-x-small", faint)}>
          <tr className="border-b border-border-faint">
            <th className={cn(head, "w-auto pl-5")}>Company</th>
            <th className={cn(head, "hidden w-40 pl-4 lg:table-cell")}>Sector</th>
            <th className={cn(head, "w-20 text-right")}>Rounds</th>
            <th className={cn(head, "w-28 text-right")}>Raised</th>
            <th className={cn(head, "w-56 pl-8 pr-5")}>Latest round</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.id}
              className="border-b border-border-faint transition-colors last:border-b-0 hover:bg-black-alpha-4 dark:hover:bg-white/4"
            >
              <td className={cn(cell, "pl-5 pr-4")}>
                <div className="flex items-start gap-3">
                  <CompanyLogo id={c.id} name={c.name} domain={c.domain} logoUrl={c.logo_url} size={28} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <IntentLink href={companyHref(c.id)} className="block truncate text-label-medium hover:underline">
                      {c.name}
                    </IntentLink>
                    <div className={cn("truncate", muted)}>{capitalizeFirst(c.description) ?? c.domain ?? ""}</div>
                  </div>
                </div>
              </td>
              <td className={cn(cell, "hidden truncate pl-4 pt-4 lg:table-cell", muted)}>
                {c.sector ? sectorLabel(c.sector) : <span className={none}>n/a</span>}
              </td>
              <td className={cn(cell, "pt-4 text-right text-mono-small")}>{c.rounds}</td>
              <td className={cn(cell, "pt-4 text-right text-mono-small")}>
                <Raised c={c} />
              </td>
              <td className={cn(cell, "truncate pl-8 pr-5 pt-4")}>
                <Latest c={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

async function CompaniesBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const { q, sort, page } = parseDirectoryParams(await searchParams, COMPANY_SORTS);
  // The same for every visitor, so a page of it is cached for a few minutes (lib/cached.ts).
  const list = await cachedCompanies(q, sort, page);
  const carried = { q, sort: sort === COMPANY_SORTS[0] ? "" : sort };
  const requestsEnabled = process.env.COMPANY_REQUESTS === "1";
  const showRequestCallout =
    requestsEnabled && shouldSuggestCompany(q, list.rows) && (list.pages === 1 || !(await hasNamedCompanyInResults(await db(), q)));

  return (
    <PageBody>
      <DirectoryControls
        placeholder="Name, description, sector, domain"
        label="Search companies"
        sorts={SORTS}
        trailing={
          requestsEnabled && (
            <RequestCompanyDialog
              initialWebsite={websiteFromQuery(q)}
              trigger={
                <Button variant="outline" size="lg">
                  Research a company
                </Button>
              }
            />
          )
        }
      />
      {showRequestCallout && <CompanyRequestCallout query={q} />}
      {requestsEnabled && <YourRequests />}
      {list.total === 0 ? (
        !showRequestCallout && <CompanyEmptyState q={q} />
      ) : (
        <div className="overflow-hidden rounded-12 border border-border-faint bg-card">
          <div className="flex h-11 items-center border-b border-border-faint px-5">
            <div className={cn("text-mono-small font-normal", muted)}>
              {list.pages > 1
                ? `${groupDigits(list.from)} to ${groupDigits(list.to)} of ${groupDigits(list.total)}`
                : groupDigits(list.total)}{" "}
              <span className="font-sans">{list.total === 1 ? "company" : "companies"}</span>
            </div>
          </div>
          <CompaniesList rows={list.rows} />
        </div>
      )}
      <Pager
        page={list.page}
        count={list.pages}
        total={list.total}
        size={DIRECTORY_PAGE_SIZE}
        hrefFor={(n) => directoryHref("/companies", carried, n)}
      />
    </PageBody>
  );
}

export const metadata = {
  title: "Companies",
  ...shareMetadata({
    title: "Companies",
    description:
      "Every company with a funding round on record: its latest round, the total raised, and the investors and sources behind each.",
    image: "root",
    canonical: "/companies",
  }),
};

export default function CompaniesPage({ searchParams }: PageProps<"/companies">) {
  return (
    <>
      <PageHeader
        section={7}
        description={
          process.env.COMPANY_REQUESTS === "1" ? (
            <>
              Every company with a round in the feed. Missing one?{" "}
              <RequestCompanyDialog
                trigger={
                  <button type="button" className="text-foreground underline underline-offset-4 hover:text-primary">
                    Research it
                  </button>
                }
              />
            </>
          ) : undefined
        }
      />
      <Suspense
        fallback={
          <PageBody>
            <div className="flex items-center gap-2">
              <PillSkeleton className="w-auto min-w-0 flex-1 sm:w-72 sm:flex-none" />
              <PillSkeleton className="w-32" />
            </div>
            <TableSkeleton
              rows={10}
              rowPad="py-3"
              headPad="py-2.5"
              cardMeta={1}
              cols={["hidden w-40 lg:block", "w-16 text-right", "w-24 text-right", "w-48"]}
            />
          </PageBody>
        }
      >
        <CompaniesBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
