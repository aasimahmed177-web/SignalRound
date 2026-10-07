import Link from "next/link";
import { CompanyLogo } from "@/components/company-logo";
import { AccuracyFlagAction } from "@/components/review/accuracy-actions";
import { Tag, type TagTone } from "@/components/ui/tag";
import type { AccuracyCompanyRow, AccuracyFlagRow, AccuracyView } from "@/lib/accuracy";
import { relativeDay, usd } from "@/lib/format";
import { companyHref } from "@/lib/links";
import { cn } from "@/lib/utils";

const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/** Each rule as a reviewer says it; the reason under it carries the specifics. */
export const RULE_LABEL: Record<string, string> = {
  no_domain: "No verified homepage",
  no_description: "No description",
  no_logo: "No logo",
  stage_regression: "Stage below an earlier round",
  list_only: "Known only from a list",
  unverified: "Under the publish bar",
  dossier_missing: "No checked dossier",
  dossier_no_founders: "No founders",
  founders_dropped: "Founders dropped",
  stage_other_large: "Large round with no stage",
  possible_duplicate: "Possible duplicate",
  no_lead_large: "No lead on a large round",
};

const REMEDY_LABEL: Record<string, string> = {
  profile: "profile refresh",
  dossier: "deep dive",
  history: "history search",
};

const SEVERITY_TONE: Record<string, TagTone> = { high: "crimson", medium: "honey", low: "muted" };

/** The day a timestamp fell on, in UTC so the server and the browser agree. */
function day(iso: string): string {
  return relativeDay(iso, { utc: true });
}

function FlagMeta({ f, view }: { f: AccuracyFlagRow; view: AccuracyView }) {
  const parts = [`Seen since ${day(f.first_seen_at)}`];
  if (view === "cleared" && f.cleared_at) parts.push(`cleared ${day(f.cleared_at)}`);
  else parts.push(`last checked ${day(f.last_seen_at)}`);
  if (f.remedy && view !== "dismissed") {
    const what = REMEDY_LABEL[f.remedy] ?? f.remedy;
    if (!f.remedied_at) parts.push(`automatic ${what} queued`);
    else {
      const note = f.remedy_note ? `: ${f.remedy_note.replace(/^[a-z ]+: /, "")}` : "";
      parts.push(`automatic ${what} ${day(f.remedied_at)}${note}`);
      if (f.remedy_exhausted && view === "open")
        parts.push(`tried ${f.remedy_attempts === 1 ? "once" : `${f.remedy_attempts} times`}, now yours`);
    }
  }
  return <p className="text-body-small text-black-alpha-32">{parts.join(" · ")}</p>;
}

function FlagItem({ company, f, view }: { company: AccuracyCompanyRow; f: AccuracyFlagRow; view: AccuracyView }) {
  const label = RULE_LABEL[f.rule] ?? f.rule;
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Tag tone={SEVERITY_TONE[f.severity] ?? "muted"}>{f.severity}</Tag>
          <span className="text-label-small">{label}</span>
        </div>
        <p className={cn("text-body-small [overflow-wrap:anywhere]", SECONDARY)}>{f.reason}</p>
        <FlagMeta f={f} view={view} />
        {f.dismissed_at && (
          <p className={cn("text-body-small", SECONDARY)}>
            Dismissed {day(f.dismissed_at)}
            {f.dismissed_note ? `: ${f.dismissed_note}` : ""}
          </p>
        )}
      </div>
      {view !== "cleared" && (
        <div className="flex shrink-0 sm:w-auto sm:justify-end">
          <AccuracyFlagAction
            companyId={company.id}
            rule={f.rule}
            label={`${company.name}, ${label.toLowerCase()}`}
            mode={view === "dismissed" ? "reopen" : "dismiss"}
          />
        </div>
      )}
    </li>
  );
}

const EMPTY: Record<AccuracyView, string> = {
  open: "Nothing to look at. The daily check reads the companies with the largest rounds and flags what a reader would notice is wrong.",
  dismissed: "No dismissed flags.",
  cleared: "Nothing cleared in the last week.",
};

/** The flagged companies, most urgent first, each flag with its reason, how long it has stood, and what the check did about it. */
export function AccuracyList({ companies, view }: { companies: AccuracyCompanyRow[]; view: AccuracyView }) {
  if (companies.length === 0) {
    return (
      <div className={cn("rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small", SECONDARY)}>
        {EMPTY[view]}
      </div>
    );
  }
  return (
    <ul className="space-y-4">
      {companies.map((c) => {
        const size = [
          c.largest_usd_millions ? `largest round ${usd(c.largest_usd_millions)}` : null,
          c.total_usd_millions ? `${usd(c.total_usd_millions)} on record` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <li key={c.id} className="rounded-12 border border-border-faint bg-card">
            <div className="flex min-w-0 items-center gap-2 border-b border-border-faint px-4 py-3 sm:px-5">
              <CompanyLogo id={c.id} name={c.name} domain={c.domain} logoUrl={c.logo_url} size={22} />
              <Link href={companyHref(c.id)} className="truncate text-label-medium hover:underline">
                {c.name}
              </Link>
              <span className={cn("hidden truncate text-body-small tabular-nums sm:block", SECONDARY)}>{size}</span>
              <span className="ml-auto shrink-0 text-mono-x-small text-black-alpha-32">
                {c.flags.length} {c.flags.length === 1 ? "FLAG" : "FLAGS"}
              </span>
            </div>
            {size && <div className={cn("px-4 pt-3 text-body-small tabular-nums sm:hidden", SECONDARY)}>{size}</div>}
            <ul className="divide-y divide-border-faint px-4 py-3 sm:px-5 sm:py-4">
              {c.flags.map((f) => (
                <FlagItem key={f.rule} company={c} f={f} view={view} />
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
