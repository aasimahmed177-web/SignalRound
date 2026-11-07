import { ArrowUpRight, Globe, Inbox, UserRound } from "lucide-react";
import { ageLabel } from "@/components/jobs/job-view";
import { EmailChip, hostOf, SourceLink } from "@/components/leads/email-chip";
import { industryLabel, type Lead } from "@/lib/leads";

function dateLabel(value: Date | null): string | null {
  if (!value) return null;
  const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(value);
  return `${date} · ${ageLabel(value)}`;
}

/** One funded startup: the round, what it does, and every contact it prints, each tied to its page. */
export function LeadCard({ lead }: { lead: Lead }) {
  const round = [lead.stage, lead.amount].filter(Boolean).join(" · ");
  const sources = [lead.fundingUrl, ...lead.otherSources];
  const contacts = lead.founders.length + lead.inboxes.length;
  return (
    <article className="border-b border-border-faint py-5 first:border-t">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_14rem] md:items-start">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-mono-x-small">
            {round && <span className="rounded-full bg-proof-green/10 px-2 py-0.5 text-proof-green">{round}</span>}
            {lead.industry && (
              <span className="rounded-full bg-black-alpha-4 px-2 py-0.5 text-black-alpha-56 dark:bg-white/6">
                {industryLabel(lead.industry)}
              </span>
            )}
            {lead.country && <span className="text-black-alpha-40">{lead.country}</span>}
            {lead.announcedOn && <span className="text-black-alpha-32">{dateLabel(lead.announcedOn)}</span>}
          </div>
          <div>
            <h2 className="text-title-h6 leading-snug [overflow-wrap:anywhere]">{lead.company}</h2>
            {lead.website && (
              <a
                href={lead.website}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-label-small text-black-alpha-56 underline-offset-4 hover:text-foreground hover:underline"
              >
                <Globe className="size-3.5 shrink-0" />
                <span className="truncate">{hostOf(lead.website)}</span>
              </a>
            )}
            {lead.brief && <p className="mt-2 max-w-3xl text-body-medium leading-relaxed text-black-alpha-56">{lead.brief}</p>}
          </div>

          {contacts > 0 ? (
            <div className="space-y-2.5 rounded-12 bg-black-alpha-4 p-3 sm:p-4 dark:bg-white/[.04]">
              {lead.founders.map((founder) => (
                <div key={founder.name} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 items-center gap-2 sm:w-52 sm:shrink-0">
                    <UserRound className="size-4 shrink-0 text-black-alpha-40" />
                    <div className="min-w-0">
                      <p className="truncate text-label-medium">{founder.name}</p>
                      {founder.role && <p className="truncate text-body-small text-black-alpha-48">{founder.role}</p>}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {founder.emails.map((email) => (
                      <EmailChip key={email.email} email={email.email} sourceUrl={email.sourceUrl} quote={email.quote} />
                    ))}
                    {founder.linkedinUrl && <SourceLink url={founder.linkedinUrl}>LinkedIn</SourceLink>}
                  </div>
                </div>
              ))}
              {lead.inboxes.length > 0 && (
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex items-center gap-2 sm:w-52 sm:shrink-0">
                    <Inbox className="size-4 shrink-0 text-black-alpha-40" />
                    <p className="text-label-medium">Company inbox{lead.inboxes.length === 1 ? "" : "es"}</p>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {lead.inboxes.map((email) => (
                      <EmailChip
                        key={email.email}
                        email={email.email}
                        sourceUrl={email.sourceUrl}
                        quote={email.quote}
                        label={email.inbox && email.inbox !== "general" && email.inbox !== "other" ? email.inbox : null}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-body-small text-black-alpha-40">No email printed on a public page yet.</p>
          )}
        </div>

        <aside className="flex flex-col gap-2 border-t border-border-faint pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-5">
          <p className="text-mono-x-small uppercase tracking-[0.12em] text-black-alpha-32">Source{sources.length === 1 ? "" : "s"}</p>
          <ul className="space-y-1">
            {sources.slice(0, 4).map((url, index) => (
              <li key={url} className="min-w-0">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-label-small text-black-alpha-56 underline-offset-4 hover:text-foreground hover:underline"
                >
                  <span className="truncate">
                    {hostOf(url)}
                    {index === 0 ? " · funding" : ""}
                  </span>
                  <ArrowUpRight className="size-3.5 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
          <p className="text-body-small text-black-alpha-40">
            {contacts ? `${contacts} contact${contacts === 1 ? "" : "s"} with a printed email` : "Company only"}
          </p>
        </aside>
      </div>
    </article>
  );
}
