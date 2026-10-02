"use client";

import { Flag } from "lucide-react";
import { type FormEvent, Fragment, useState, useTransition } from "react";
import { toast } from "sonner";
import { report } from "@/app/actions";
import { Confidence, HalfCircle } from "@/components/confidence";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hostLabel } from "@/lib/format";
import type { FeedRow } from "@/lib/persist";
import { readAgainst } from "@/lib/source-count";
import { cn } from "@/lib/utils";
import { type ChangeNote, parseNotes } from "@/lib/verifier-notes";

const faint = "text-black-alpha-32 dark:text-muted-foreground";

/** Changes shown before the toggle; one more would take the toggle's own line, so it folds only past that. */
const CHANGES_SHOWN = 4;
/** A remark longer than this clamps to three lines until the toggle opens it. */
const REMARK_CLAMP = 220;

/** A cited host links to the row's source on that host; a host no source carries stays plain. */
function Host({ host, sources }: { host: string; sources: FeedRow["sources"] }) {
  const source = sources.find((s) => hostLabel(s.host) === hostLabel(host));
  return source ? (
    <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
      {hostLabel(source.host)}
    </a>
  ) : (
    hostLabel(host)
  );
}

/**
 * One change the verifier made, as a label and what it carries: "Lead added  Emergence · verda.com".
 * Names cited to one host say it once after the list; names cited to several say each. The stored
 * line is the tooltip.
 */
function Change({ note, sources }: { note: ChangeNote; sources: FeedRow["sources"] }) {
  const hosts = new Set(note.items.map((i) => i.host));
  const shared = note.items.length > 1 && hosts.size === 1 ? note.items[0].host : null;
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{note.label}</dt>
      <dd className="min-w-0" title={note.raw}>
        {note.items.map((item, i) => (
          <Fragment key={item.text}>
            {i > 0 && ", "}
            {item.text}
            {item.host && !shared && (
              <span className="text-muted-foreground">
                {" · "}
                <Host host={item.host} sources={sources} />
              </span>
            )}
          </Fragment>
        ))}
        {shared && (
          <span className="text-muted-foreground">
            {" · "}
            <Host host={shared} sources={sources} />
          </span>
        )}
        {note.detail && <span className="text-muted-foreground"> · {note.detail}</span>}
      </dd>
    </>
  );
}

function ReportForm({ id, onSent }: { id: string; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    start(async () => {
      const r = await report(id, reason);
      if (r.ok) {
        toast.success("Reported", { description: "The row is in the review queue." });
        onSent();
      } else setError(r.error);
    });
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <Input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What is wrong?"
        aria-label="What is wrong?"
        className="h-7 max-w-72 text-[13px] md:text-[13px]"
        disabled={pending}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending || !reason.trim()}>
        Send
      </Button>
      {error && <p className="w-full text-mono-x-small text-crimson-ink">{error}</p>}
    </form>
  );
}

/**
 * The verifier's word on a row, as a block a reader can act on: who read it and against how much,
 * then what it changed, one labelled line each with its source linked, then its remark, then a way
 * to report what the verifier missed. A contradicted or not-news verdict never reaches the feed, so the header is confirmed,
 * corrected, or not yet.
 */
export function Verified({ r, readOnly = false }: { r: FeedRow; readOnly?: boolean }) {
  const [reporting, setReporting] = useState(false);
  const [sent, setSent] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  // Skipped and unverified rows have no verdict to describe; null means never read.
  const v = r.verification && r.verification.status !== "unverified" && r.verification.status !== "skipped" ? r.verification : null;
  const label =
    !v || r.disposition === "flagged"
      ? "DEVELOPING"
      : v.status === "confirmed"
        ? "VERIFIED"
        : v.status === "corrected"
          ? "VERIFIED · CORRECTED"
          : v.status.toUpperCase();
  // Which model reconciled a row is operator detail (Settings shows it); the reader needs how much it read.
  const reconciled = Boolean(v?.verifier && v.verifier !== "judge");
  // "read against 1 of 2 sources" when pages arrived after the read; the count is always the list's.
  const reach = readAgainst(r) ?? `${r.sources.length} ${r.sources.length === 1 ? "source" : "sources"}`;
  const notes = r.verification?.notes ?? [];
  const { changes, remarks } = parseNotes(notes, [...r.lead_investors, ...r.other_investors]);
  const foldsChanges = changes.length > CHANGES_SHOWN + 1;
  const clampsRemark = remarks.some((n) => n.raw.length > REMARK_CLAMP);

  return (
    <div className="space-y-1.5">
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-mono-x-small", faint)}>
        <span>[ {label} ]</span>
        {/* The score that set the disposition, for an admin asking why a row is flagged. A bare "0.61" means nothing to a visitor, who reads the verdict and the flag line instead. */}
        {!readOnly && (
          <span
            className="text-muted-foreground"
            title="Confidence: sources, dating, publisher tier, agreement, and evidence, scored 0 to 1. Publish at 0.75, flagged to 0.50, review below."
          >
            <Confidence value={r.confidence} />
          </span>
        )}
      </div>
      {/* The table shows a flagged row as a half-filled circle and its count; this is where the state is said in full. */}
      {r.disposition === "flagged" && (
        <p className="flex items-start gap-1.5 text-body-small text-black-alpha-72 dark:text-foreground/80">
          <HalfCircle className="mt-1 size-3 shrink-0 text-black-alpha-48" />
          <span>
            {v
              ? "Developing: it holds up against its sources so far, and firms up as more reporting lands."
              : "Developing: reported, and still being confirmed against its sources."}
          </span>
        </p>
      )}
      {v && (
        <div className="text-body-small text-black-alpha-56 dark:text-muted-foreground">
          {reconciled ? (
            `read against ${reach}`
          ) : v.url ? (
            <>
              read against its{" "}
              <a href={v.url} target="_blank" rel="noreferrer" className="hover:underline">
                primary page
              </a>
            </>
          ) : (
            "read against its primary page"
          )}
        </div>
      )}
      {/* What the verifier changed, one line each; then its remark in its own words. */}
      {changes.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-body-small text-black-alpha-72 dark:text-foreground/80">
          {(foldsChanges && !allNotes ? changes.slice(0, CHANGES_SHOWN) : changes).map((n) => (
            <Change key={n.raw} note={n} sources={r.sources} />
          ))}
        </dl>
      )}
      {remarks.map((n) => {
        const clamped = !allNotes && n.raw.length > REMARK_CLAMP;
        return (
          <p
            key={n.raw}
            title={clamped ? n.raw : undefined}
            className={cn("text-body-small text-black-alpha-72 dark:text-foreground/80", clamped && "line-clamp-3")}
          >
            {n.text}
          </p>
        );
      })}
      {(foldsChanges || clampsRemark) && (
        <button
          type="button"
          aria-expanded={allNotes}
          onClick={() => setAllNotes((v) => !v)}
          className="rounded-4 text-label-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {allNotes ? "Show less" : foldsChanges ? `Show all ${notes.length} notes` : "Show full note"}
        </button>
      )}
      {/* The report control is a write; demo visitors read the verdict but do not file one. */}
      {!readOnly && (
        <div className="pt-1">
          {sent ? (
            <span className={cn("text-mono-x-small", faint)}>[ REPORTED · IN REVIEW ]</span>
          ) : reporting ? (
            <ReportForm id={r.id} onSent={() => setSent(true)} />
          ) : (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setReporting(true)}>
              <Flag /> Report
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
