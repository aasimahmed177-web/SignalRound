import { ArrowUpRight, Braces, CheckCircle2, CircleDotDashed, Mail, SearchCheck, Waypoints } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { SignalActions } from "@/components/signals/signal-actions";
import { CardListSkeleton } from "@/components/ui/skeletons";
import { db } from "@/lib/db";
import { listSignalInbox, SIGNAL_STATUSES, type SignalRow, type SignalStatus } from "@/lib/signals";
import { cn } from "@/lib/utils";

const FILTERS: Array<{ id: SignalStatus | "all"; label: string }> = [
  { id: "all", label: "All signals" },
  { id: "new", label: "New" },
  { id: "researching", label: "Researching" },
  { id: "matched", label: "Matched" },
  { id: "dismissed", label: "Dismissed" },
];

function selectedStatus(value: string | string[] | undefined): SignalStatus | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return SIGNAL_STATUSES.includes(first as SignalStatus) ? (first as SignalStatus) : undefined;
}

const FLOW = [
  { label: "Discover", detail: "Source workers observe", icon: Waypoints },
  { label: "Corroborate", detail: "Research reads sources", icon: SearchCheck },
  { label: "Match", detail: "Resolve company + round", icon: CircleDotDashed },
  { label: "Publish", detail: "Verified record only", icon: CheckCircle2 },
];

function ProofRail({ status }: { status: SignalStatus }) {
  const active = status === "new" ? 0 : status === "researching" ? 1 : status === "matched" ? 3 : -1;
  return (
    <div className="grid grid-cols-4 gap-1" role="img" aria-label={`Signal state: ${status}`}>
      {FLOW.map((step, index) => (
        <div key={step.label} className="space-y-1">
          <div
            className={cn(
              "h-1 rounded-full",
              status === "dismissed" ? "bg-black-alpha-8" : index <= active ? "bg-signal-blue" : "bg-black-alpha-8 dark:bg-white/10",
            )}
          />
          <span className={cn("hidden text-mono-x-small sm:block", index === active ? "text-signal-blue" : "text-black-alpha-32")}>
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dateLabel(value: Date): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}

function statusLabel(status: string): string {
  return status === "researching" ? "In research" : status[0]?.toUpperCase() + status.slice(1);
}

function publicContacts(row: SignalRow): Array<{ email: string; sourceUrl: string }> {
  const value = row.metadata.public_contacts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((contact) => {
    if (!contact || typeof contact !== "object") return [];
    const email = "email" in contact && typeof contact.email === "string" ? contact.email : null;
    const sourceUrl = "sourceUrl" in contact && typeof contact.sourceUrl === "string" ? contact.sourceUrl : null;
    return email && sourceUrl ? [{ email, sourceUrl }] : [];
  });
}

function fundingLabel(row: SignalRow): string | null {
  const value = row.metadata.funding;
  if (!value || typeof value !== "object") return null;
  const amount = "amount_as_written" in value && typeof value.amount_as_written === "string" ? value.amount_as_written : null;
  const stage = "stage_as_written" in value && typeof value.stage_as_written === "string" ? value.stage_as_written : null;
  return [amount, stage].filter(Boolean).join(" · ") || null;
}

function SignalCard({ row }: { row: SignalRow }) {
  const status = SIGNAL_STATUSES.includes(row.status as SignalStatus) ? (row.status as SignalStatus) : "new";
  const contacts = publicContacts(row);
  const funding = fundingLabel(row);
  return (
    <article className="group border-b border-border-faint py-5 first:border-t">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_13rem] md:items-start">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-mono-x-small">
            <span className="rounded-full bg-signal-blue/10 px-2 py-1 font-medium uppercase tracking-[0.12em] text-signal-blue">
              {row.channel}
            </span>
            <span className="text-black-alpha-32">{dateLabel(row.lastSeenAt)}</span>
            {row.seenCount > 1 && <span className="text-black-alpha-32">seen {row.seenCount}×</span>}
          </div>
          <div>
            {row.company && <p className="mb-1 text-mono-x-small uppercase tracking-[0.12em] text-black-alpha-40">{row.company}</p>}
            <h2 className="max-w-3xl text-title-h6 leading-snug text-balance">{row.title ?? row.summary}</h2>
            {row.title && row.summary && (
              <p className="mt-2 max-w-3xl text-body-medium leading-relaxed text-black-alpha-56">{row.summary}</p>
            )}
          </div>
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-label-small text-black-alpha-56 underline-offset-4 hover:text-foreground hover:underline"
          >
            <span className="truncate">{hostOf(row.url)}</span>
            <ArrowUpRight className="size-3.5 shrink-0" />
          </a>
          {(funding || contacts.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-label-small">
              {funding && <span className="rounded-full bg-proof-green/10 px-2.5 py-1 text-proof-green">{funding}</span>}
              {contacts.map((contact) => (
                <a
                  key={contact.email}
                  href={`mailto:${contact.email}`}
                  title={`Found on ${contact.sourceUrl}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-signal-blue/10 px-2.5 py-1 text-signal-blue hover:bg-signal-blue/15"
                >
                  <Mail className="size-3.5" />
                  {contact.email}
                </a>
              ))}
            </div>
          )}
          <ProofRail status={status} />
        </div>
        <aside className="flex items-center justify-between gap-4 border-t border-border-faint pt-4 md:block md:border-l md:border-t-0 md:pl-5 md:pt-0">
          <div className="space-y-1">
            <p className="text-mono-x-small uppercase tracking-[0.12em] text-black-alpha-32">{statusLabel(status)}</p>
            <p className="text-label-medium">
              {row.confidence === null ? "No lead score" : `${Math.round(row.confidence * 100)}% lead score`}
            </p>
            <p className="hidden text-body-small text-black-alpha-56 md:block">Discovery confidence, not proof.</p>
          </div>
          <div className="md:mt-4">
            <SignalActions id={row.id} status={status} />
          </div>
        </aside>
      </div>
    </article>
  );
}

async function SignalsBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const status = selectedStatus((await searchParams).status);
  const inbox = await listSignalInbox(await db(), status);
  const selected = status ?? "all";

  return (
    <PageBody>
      <section className="overflow-hidden rounded-16 border border-signal-ink/10 bg-paper text-signal-ink dark:border-white/10 dark:bg-[#18212b] dark:text-white">
        <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,.65fr)]">
          <div className="p-6 sm:p-8">
            <p className="text-mono-x-small uppercase tracking-[0.18em] text-signal-blue">Evidence boundary</p>
            <h2 className="mt-3 max-w-2xl text-title-h4 text-balance sm:text-title-h3">Rumors can enter. Only proof reaches the feed.</h2>
            <p className="mt-3 max-w-2xl text-body-medium leading-relaxed text-signal-ink/65 dark:text-white/65">
              Agent Reach, direct web feeds, filings, and social sources all land here first. SignalRound preserves the source while its
              native research pipeline checks the company, amount, stage, website, and public contact points.
            </p>
          </div>
          <div className="border-t border-signal-ink/10 bg-white/55 p-6 lg:border-l lg:border-t-0 dark:border-white/10 dark:bg-white/[.03]">
            <div className="flex items-center gap-2 text-mono-x-small uppercase tracking-[0.14em] text-signal-ink/45 dark:text-white/45">
              <Braces className="size-4" /> Intake contract
            </div>
            <code className="mt-5 block text-[13px] leading-6 text-signal-ink dark:text-white">
              <span className="text-proof-green">POST</span> /api/v1/signals
              <br />
              Authorization: Bearer ···
              <br />
              channel · url · title | summary
            </code>
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-signal-ink/10 lg:grid-cols-4 dark:border-white/10">
          {FLOW.map((step, index) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className="flex gap-3 border-signal-ink/10 px-4 py-4 [&:not(:nth-child(odd))]:border-l [&:nth-child(n+3)]:border-t lg:px-5 lg:[&:not(:first-child)]:border-l lg:[&:nth-child(n+3)]:border-t-0 dark:border-white/10"
              >
                <span className="font-mono text-xs text-signal-blue">0{index + 1}</span>
                <Icon className="mt-0.5 size-4 shrink-0 text-signal-ink/40 dark:text-white/40" />
                <div>
                  <p className="text-label-small">{step.label}</p>
                  <p className="mt-0.5 text-body-small text-signal-ink/50 dark:text-white/50">{step.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="inbox-heading">
        <div className="flex flex-col gap-4 border-b border-border-faint pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-mono-x-small uppercase tracking-[0.14em] text-black-alpha-32">Live queue</p>
            <h2 id="inbox-heading" className="mt-1 text-title-h5">
              {inbox.rows.length} {selected === "all" ? "observations" : `${selected} observations`}
            </h2>
          </div>
          <nav aria-label="Signal status" className="flex flex-wrap gap-1.5">
            {FILTERS.map((filter) => (
              <Link
                key={filter.id}
                href={filter.id === "all" ? "/signals" : `/signals?status=${filter.id}`}
                aria-current={selected === filter.id ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full px-3 text-label-small transition-colors",
                  selected === filter.id
                    ? "bg-signal-ink text-white dark:bg-white dark:text-signal-ink"
                    : "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6",
                )}
              >
                {filter.label} <span className="font-mono text-[11px] opacity-65">{inbox.counts[filter.id]}</span>
              </Link>
            ))}
          </nav>
        </div>

        {inbox.rows.length ? (
          <div>
            {inbox.rows.map((row) => (
              <SignalCard key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="border-b border-border-faint py-16 text-center">
            <p className="text-title-h6">No {status ?? ""} signals waiting.</p>
            <p className="mx-auto mt-2 max-w-md text-body-medium text-black-alpha-56">
              Send a discovery worker to <code className="font-mono text-[.9em]">POST /api/v1/signals</code>, or choose another status.
            </p>
          </div>
        )}
      </section>
    </PageBody>
  );
}

export const metadata = { title: "Signal inbox" };

export default function SignalsPage({ searchParams }: PageProps<"/signals">) {
  return (
    <>
      <PageHeader
        section={9}
        description="Unverified observations from every source, held outside the feed until the evidence is strong enough."
      />
      <Suspense
        fallback={
          <PageBody>
            <CardListSkeleton rows={4} />
          </PageBody>
        }
      >
        <SignalsBody searchParams={searchParams as Promise<Record<string, string | string[] | undefined>>} />
      </Suspense>
    </>
  );
}
