import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { LeadCard } from "@/components/leads/lead-card";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { CardListSkeleton } from "@/components/ui/skeletons";
import { db } from "@/lib/db";
import { industryLabel, listLeads } from "@/lib/leads";
import { cn } from "@/lib/utils";

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function href(params: { q?: string; industry?: string; email?: boolean }): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.industry) search.set("industry", params.industry);
  if (params.email) search.set("email", "1");
  const query = search.toString();
  return query ? `/leads?${query}` : "/leads";
}

const chip = (active: boolean) =>
  cn(
    "inline-flex h-8 items-center gap-2 rounded-full px-3 text-label-small transition-colors",
    active
      ? "bg-signal-ink text-white dark:bg-white dark:text-signal-ink"
      : "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6",
  );

async function LeadsBody({ searchParams }: { searchParams: Promise<Params> }) {
  await connection();
  const params = await searchParams;
  const q = first(params.q)?.slice(0, 120);
  const industry = first(params.industry)?.slice(0, 40);
  const email = first(params.email) === "1";
  const listing = await listLeads(await db(), { q, industry, withEmail: email });

  return (
    <PageBody>
      <section aria-labelledby="leads-heading">
        <div className="flex flex-col gap-4 border-b border-border-faint pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-mono-x-small uppercase tracking-[0.14em] text-black-alpha-32">
                {listing.counts.withEmail} with an email · {listing.counts.founderEmails} founder email
                {listing.counts.founderEmails === 1 ? "" : "s"} · {listing.counts.inboxes} inbox
                {listing.counts.inboxes === 1 ? "" : "es"}
              </p>
              <h2 id="leads-heading" className="mt-1 text-title-h5">
                {listing.rows.length} funded startup{listing.rows.length === 1 ? "" : "s"}
                {q ? ` matching “${q}”` : ""}
              </h2>
            </div>
            <form action="/leads" className="flex gap-2">
              {industry && <input type="hidden" name="industry" value={industry} />}
              {email && <input type="hidden" name="email" value="1" />}
              <input
                name="q"
                defaultValue={q}
                maxLength={120}
                placeholder="Filter by company or brief"
                aria-label="Filter leads"
                className="h-9 w-full min-w-0 rounded-8 border border-border-faint bg-background px-3 text-body-small outline-none focus-visible:ring-2 focus-visible:ring-signal-blue sm:w-64"
              />
            </form>
          </div>
          <nav aria-label="Lead filters" className="flex flex-wrap gap-1.5">
            <Link href={href({ q, industry })} className={chip(!email)} aria-current={!email ? "page" : undefined}>
              All
            </Link>
            <Link href={href({ q, industry, email: true })} className={chip(email)} aria-current={email ? "page" : undefined}>
              With an email
            </Link>
            <span aria-hidden className="mx-1 hidden h-8 w-px bg-border-faint sm:block" />
            {industry && (
              <Link href={href({ q, email })} className={chip(false)}>
                Any industry
              </Link>
            )}
            {listing.industries.map((id) => (
              <Link
                key={id}
                href={href({ q, email, industry: industry === id ? undefined : id })}
                className={chip(industry === id)}
                aria-current={industry === id ? "page" : undefined}
              >
                {industryLabel(id)}
              </Link>
            ))}
          </nav>
        </div>
        <p className="pt-4 text-body-small text-black-alpha-56">
          Every email here is printed on a public page; hover one (or tap “source” on a phone) for the line and the page. Nothing is
          guessed, and founders show only with an email of their own.
        </p>
        {listing.rows.length ? (
          <div className="mt-2">
            {listing.rows.map((lead) => (
              <LeadCard key={lead.id} lead={lead} />
            ))}
          </div>
        ) : (
          <div className="border-b border-border-faint py-16 text-center">
            <p className="text-title-h6">No funded startups here yet.</p>
            <p className="mx-auto mt-2 max-w-md text-body-medium text-black-alpha-56">
              Run <code className="font-mono text-[.9em]">pnpm collect:funded -- --apply</code> to read this week's funding news.
            </p>
          </div>
        )}
      </section>
    </PageBody>
  );
}

export const metadata = { title: "Leads" };

export default function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  return (
    <>
      <PageHeader section={12} />
      <Suspense
        fallback={
          <PageBody>
            <CardListSkeleton rows={5} />
          </PageBody>
        }
      >
        <LeadsBody searchParams={searchParams} />
      </Suspense>
    </>
  );
}
