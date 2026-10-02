import { hostOf } from "@fireround/core";
import { ExternalLink } from "lucide-react";
import { DeepDiveButton } from "@/components/company/deep-dive-button";
import { FounderList } from "@/components/company/founder-list";
import { RelativeDay } from "@/components/relative-day";
import { Panel } from "@/components/ui/stat";
import type { FounderLine } from "@/lib/company-groups";
import type { Dossier } from "@/lib/deepdive";
import { hostLabel } from "@/lib/format";
import { capitalizeFirst } from "@/lib/text";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * "Checked against 7 sources": what the check did, in one quiet line. The admin also sees how many
 * claims it dropped; a visitor reads what stayed, and a count of what went reads like a defect.
 */
function checkedLine(dossier: Dossier, admin: boolean): React.ReactNode {
  const v = dossier.verification;
  if (!v) return null;
  const n = v.sources_checked.length;
  const dropped = v.dropped.length;
  // The day is the reader's (RelativeDay): "today", "3d ago", or "on Sep 20".
  return (
    <>
      Checked against {n} {n === 1 ? "source" : "sources"} <RelativeDay iso={v.checked_at} onDate />
      {admin && dropped > 0 ? ` · ${dropped} ${dropped === 1 ? "claim" : "claims"} dropped` : null}
    </>
  );
}

/** The page a URL names within its host: "/our-team", or "/" for the homepage. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/\/+$/, "")) || "/";
  } catch {
    return url;
  }
}

/** The URLs the dossier read, one group per host in the order first read. */
function byHost(urls: string[]): Array<{ host: string; urls: string[] }> {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const host = hostLabel(hostOf(url) || url);
    groups.set(host, [...(groups.get(host) ?? []), url]);
  }
  return [...groups].map(([host, urls]) => ({ host, urls }));
}

/**
 * The agent's reading of the company, as the dossier check left it: what an analyst pulls together
 * before a first call, with every claim that did not check out against its sources taken away.
 * Visitors only ever get a checked dossier (lib/company.ts); an admin also sees one written before
 * the check, marked as such until the backfill checks it. `canRefresh` is false for a demo visitor,
 * who reads the dossier but may not pay for a new one.
 *
 * The panel keeps to what only the dossier says. The page shows the rest once, where it belongs:
 * founded and headcount in the header line, backers under Investors, prior rounds under Rounds.
 * `founders` is the page's one founders list, the dossier's merged with YC's (mergeFounders).
 * `total` is the dossier's total raised only while the record leaves it standing (dossierTotal), and
 * `predates` names the round the dossier was written before, which an admin is told so they can
 * refresh it.
 */
export function DossierPanel({
  companyId,
  dossier,
  canRefresh,
  founders,
  foundersVia,
  total,
  predates,
}: {
  companyId: string;
  dossier: Dossier;
  canRefresh: boolean;
  founders: FounderLine[];
  foundersVia: string | null;
  total: string | null;
  predates: string | null;
}) {
  const d = dossier.data;
  const checked = checkedLine(dossier, canRefresh);
  const read = byHost(d.sources);
  return (
    <Panel
      title="Company research"
      // The check state is the pipeline's; a visitor reads the "Checked against" line below instead.
      code={canRefresh ? (dossier.verification ? "CHECKED" : "UNCHECKED") : undefined}
      action={
        <span className="flex items-center gap-3 text-body-small text-muted-foreground">
          <span className="hidden sm:inline">
            Fetched <RelativeDay iso={dossier.fetched_at} />
          </span>
          {canRefresh && <DeepDiveButton companyId={companyId} mode="refresh" />}
        </span>
      }
    >
      <div className="space-y-5">
        {!dossier.verification && (
          <p className="text-body-small text-muted-foreground">
            Written before dossiers were checked against their sources, so visitors do not see it. The dossier backfill checks it, or
            Refresh builds a new one.
          </p>
        )}
        {canRefresh && predates && (
          <p className="text-body-small text-muted-foreground">
            Written before the {predates}, so it may miss what came with it. Refresh brings it up to date.
          </p>
        )}
        {d.one_liner && <p className="text-body-medium">{capitalizeFirst(d.one_liner)}</p>}

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-body-small">
          {founders.length > 0 && (
            <Row label="Founders">
              <FounderList founders={founders} via={foundersVia} />
            </Row>
          )}
          {d.business_model && <Row label="Business model">{capitalizeFirst(d.business_model)}</Row>}
          {total && (
            <Row label="Total raised">
              {total}
              <span className="text-muted-foreground"> · as its sources put it, more than the rounds on record</span>
            </Row>
          )}
          {d.customers.length > 0 && <Row label="Customers">{d.customers.join(", ")}</Row>}
          {d.competitors.length > 0 && <Row label="Competitors">{d.competitors.join(", ")}</Row>}
        </dl>

        {d.why_it_matters && (
          <div>
            <div className="mb-1 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">WHY IT MATTERS</div>
            <p className="text-body-small text-black-alpha-72 dark:text-muted-foreground">{capitalizeFirst(d.why_it_matters)}</p>
          </div>
        )}

        {(checked || read.length > 0) && (
          <div className="space-y-2 border-t border-border-faint pt-4 text-body-small text-muted-foreground">
            {checked && <p>{checked}</p>}
            {read.length > 0 && (
              <div>
                <div className="mb-1 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
                  {dossier.verification ? "SOURCES" : "READ"}
                </div>
                {/* One line per host: a host read once links itself; a host read for several pages links each page by its path. */}
                <ul className="space-y-1">
                  {read.map(({ host, urls }) => (
                    <li key={host} className="flex min-w-0 items-baseline gap-2">
                      <ExternalLink
                        className="size-3 shrink-0 translate-y-0.5 text-black-alpha-32 dark:text-muted-foreground"
                        aria-hidden
                      />
                      {urls.length === 1 ? (
                        <a
                          href={urls[0]}
                          target="_blank"
                          rel="noreferrer"
                          title={urls[0]}
                          className="min-w-0 truncate hover:text-foreground hover:underline"
                        >
                          {host}
                          {pathOf(urls[0]) !== "/" && <span className="text-black-alpha-32">{pathOf(urls[0])}</span>}
                        </a>
                      ) : (
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="shrink-0">{host}</span>
                          {urls.map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              title={url}
                              className="max-w-64 truncate text-black-alpha-32 hover:text-foreground hover:underline"
                            >
                              {pathOf(url)}
                            </a>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
