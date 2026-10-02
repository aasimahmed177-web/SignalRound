"use client";

import { Copy } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { countLabel, type RunState } from "@/lib/runs";
import { cn } from "@/lib/utils";

/** One run as the list shows it: the server reads the row (labels, state, relative times) so the client paints what it was handed. */
export interface RunView {
  id: string;
  laneName: string;
  qualifier: string | null;
  /** The preset's display name, or null for a lane that owns its preset column (agent, Form D). */
  preset: string | null;
  presetSlug: string;
  state: RunState;
  /** The STALLED tooltip, set only on a stalled row. */
  stalledNote: string | null;
  startedAt: string;
  finishedAt: string | null;
  started: string;
  duration: string;
  counts: Record<string, number> | null;
  /** What the run cost; null for a viewer who may not see spend (seesSpend), and every credit column goes with it. */
  credits: RunCredits | null;
  error: string | null;
  errorSnippet: string | null;
}

export interface RunCredits {
  estimated: number | null;
  measured: number | null;
  charged: number;
  overlapped: boolean;
}

const OVERLAP_NOTE = "Overlapped another run; the total charges its estimate";
const muted = "text-black-alpha-56 dark:text-muted-foreground";
const faint = "text-black-alpha-32 dark:text-muted-foreground";
const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** Why a count cell is blank: an open row has not reported yet; a finished one never counted it. */
function countNote(r: RunView): string {
  return r.state === "running" ? "Not reported yet: counts land as the run goes" : "Not measured: this kind of run does not count it";
}

/** Why the measured cell is blank: no finish yet, no finish ever, or a key the balance read cannot meter. */
function measuredNote(r: RunView): string {
  if (r.state === "running") return "Measured when the run finishes";
  if (r.state === "stalled") return "Not measured: the run never finished";
  return "Not measured: this key is not metered";
}

/**
 * A figure cell. Null is "not measured" and shows a dash with the reason on hover (and to a
 * screen reader); a measured zero shows 0, so a blank never stands for either.
 */
function Figure({ value, note }: { value: number | null | undefined; note: string }) {
  if (value === null || value === undefined) {
    return (
      <span title={note} className={faint}>
        <span aria-hidden>n/a</span>
        <span className="sr-only">{note}</span>
      </span>
    );
  }
  return <>{value}</>;
}

function Measured({ r, c }: { r: RunView; c: RunCredits }) {
  return (
    <span className={cn(c.overlapped && muted)} title={c.overlapped ? OVERLAP_NOTE : undefined}>
      <Figure value={c.measured} note={measuredNote(r)} />
    </span>
  );
}

function StateTag({ r }: { r: RunView }) {
  if (r.state === "running") return <Tag tone="heat">RUNNING</Tag>;
  if (r.state === "failed") return <Tag tone="crimson">FAILED</Tag>;
  if (r.state === "stalled")
    return (
      <span title={r.stalledNote ?? undefined} className="shrink-0">
        <Tag tone="honey">STALLED</Tag>
        <span className="sr-only">{r.stalledNote}</span>
      </span>
    );
  return null;
}

function LaneName({ r }: { r: RunView }) {
  return (
    <>
      {r.laneName}
      {r.qualifier && <span className={muted}> · {r.qualifier}</span>}
    </>
  );
}

/**
 * The run list in both shapes, and the detail sheet either opens. Both layouts render and CSS
 * picks one (the feed table's pattern), so the first paint is right at every width.
 */
export function RunsList({ runs }: { runs: RunView[] }) {
  // One viewer per page, so either every row carries credits or none does.
  const spend = runs.some((r) => r.credits !== null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = runs.find((r) => r.id === openId) ?? null;
  // The sheet has no Trigger to hand focus back to, so it remembers the lane button that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const openRun = (id: string, from: HTMLElement | null) => {
    opener.current = from;
    setOpenId(id);
  };

  const head = "py-2.5 text-left font-normal";
  const num = "text-right";
  const cell = "py-3 align-top";
  const mono = "text-mono-small";

  return (
    <div className="overflow-hidden rounded-12 border border-border-faint bg-card">
      <ul className="text-body-small md:hidden">
        {runs.map((r) => (
          <li
            key={r.id}
            className="relative border-b border-border-faint px-4 py-3 transition-colors last:border-b-0 hover:bg-black-alpha-4 dark:hover:bg-white/4"
          >
            <div className="flex min-w-0 items-center gap-2">
              {/* The lane name is the card's one control: its ::after covers the card, so a tap anywhere opens the sheet and a keyboard reaches the same button. */}
              <button
                type="button"
                onClick={(e) => openRun(r.id, e.currentTarget)}
                aria-label={`Details for ${r.laneName}${r.qualifier ? ` ${r.qualifier}` : ""} run, ${r.started}`}
                className={cn("min-w-0 truncate rounded-4 text-left text-label-small after:absolute after:inset-0", focusRing)}
              >
                <LaneName r={r} />
              </button>
              <StateTag r={r} />
              <span className={cn("ml-auto shrink-0", mono, muted)}>{r.started}</span>
            </div>
            <div className={cn("mt-0.5 flex min-w-0 items-center gap-2", muted)}>
              {r.preset && <span className="min-w-0 truncate">{r.preset}</span>}
              {r.preset && <span aria-hidden>·</span>}
              <span className={cn("shrink-0", mono)}>{r.duration}</span>
            </div>
            {r.errorSnippet && <div className={cn("mt-0.5 truncate", muted)}>{r.errorSnippet}</div>}
            <dl className={cn("mt-2 grid gap-x-2", spend ? "grid-cols-5" : "grid-cols-3")}>
              <CardFigure label="Pages">
                <Figure value={r.counts?.pages_extracted} note={countNote(r)} />
              </CardFigure>
              <CardFigure label="Rounds">
                <Figure value={r.counts?.rounds_extracted} note={countNote(r)} />
              </CardFigure>
              <CardFigure label="Records">
                <Figure value={r.counts?.records} note={countNote(r)} />
              </CardFigure>
              {r.credits && (
                <>
                  <CardFigure label="Est.">
                    <Figure value={r.credits.estimated} note="No estimate recorded" />
                  </CardFigure>
                  <CardFigure label="Measured">
                    <Measured r={r} c={r.credits} />
                  </CardFigure>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>

      {/* Fixed layout, the feed table's shape: the header row sets every width and the lane column
          absorbs the difference. Duration and pages leave below xl so nothing clips at 1100. */}
      <table className="hidden w-full table-fixed text-body-small md:table">
        <thead className={cn("text-mono-x-small", faint)}>
          <tr className="border-b border-border-faint">
            <th className={cn(head, "pl-5")}>Run</th>
            <th className={cn(head, "w-36")}>{spend ? "Preset" : "Watchlist"}</th>
            <th className={cn(head, "w-24")}>Started</th>
            <th className={cn(head, "hidden w-20 xl:table-cell")}>Duration</th>
            <th className={cn(head, num, "hidden w-16 xl:table-cell")}>Pages</th>
            <th className={cn(head, num, "w-16")}>Rounds</th>
            <th className={cn(head, num, "w-20", !spend && "pr-5")}>Records</th>
            {spend && (
              <>
                <th className={cn(head, num, "w-16")}>Est.</th>
                <th className={cn(head, num, "w-24 pr-5")}>Measured</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              onClick={(e) => openRun(r.id, e.currentTarget.querySelector("button"))}
              className="cursor-pointer border-b border-border-faint transition-colors last:border-0 hover:bg-black-alpha-4 dark:hover:bg-white/4"
            >
              <td className={cn(cell, "pl-5 pr-3")}>
                <div className="flex min-w-0 items-center gap-2">
                  {/* The row is clickable for the mouse; this button is the same action for a keyboard or a screen reader. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRun(r.id, e.currentTarget);
                    }}
                    aria-label={`Details for ${r.laneName}${r.qualifier ? ` ${r.qualifier}` : ""} run, ${r.started}`}
                    className={cn("tap relative min-h-6 min-w-0 cursor-pointer truncate rounded-4 text-left text-label-small", focusRing)}
                  >
                    <LaneName r={r} />
                  </button>
                  <StateTag r={r} />
                </div>
                {r.errorSnippet && (
                  <div className={cn("truncate", muted)} title={r.error ?? undefined}>
                    {r.errorSnippet}
                  </div>
                )}
              </td>
              <td className={cn(cell, "truncate pr-3", muted)} title={r.presetSlug}>
                {r.preset}
              </td>
              <td className={cn(cell, mono, muted)}>{r.started}</td>
              <td className={cn(cell, mono, "hidden xl:table-cell")}>{r.duration}</td>
              <td className={cn(cell, mono, num, "hidden xl:table-cell")}>
                <Figure value={r.counts?.pages_extracted} note={countNote(r)} />
              </td>
              <td className={cn(cell, mono, num)}>
                <Figure value={r.counts?.rounds_extracted} note={countNote(r)} />
              </td>
              <td className={cn(cell, mono, num, !r.credits && "pr-5")}>
                <Figure value={r.counts?.records} note={countNote(r)} />
              </td>
              {r.credits && (
                <>
                  <td className={cn(cell, mono, num, muted)}>
                    <Figure value={r.credits.estimated} note="No estimate recorded" />
                  </td>
                  <td className={cn(cell, mono, num, "pr-5")}>
                    <Measured r={r} c={r.credits} />
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent
          className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
          onCloseAutoFocus={(e) => {
            if (!opener.current?.isConnected) return;
            e.preventDefault();
            opener.current.focus();
          }}
        >
          {open && <RunDetail r={open} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CardFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={cn("truncate text-mono-x-small", faint)}>{label}</dt>
      <dd className="truncate text-mono-small">{children}</dd>
    </div>
  );
}

/** An absolute time in the reader's zone; the ISO string rides along on hover. Rendered only in the open sheet, so server and client never disagree. */
function Absolute({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}
    </time>
  );
}

function CreditsSection({ r, c }: { r: RunView; c: RunCredits }) {
  return (
    <Section title="CREDITS">
      <dl>
        <Row label="Estimated">
          <Figure value={c.estimated} note="No estimate recorded" />
        </Row>
        <Row label="Measured">
          <Figure value={c.measured} note={measuredNote(r)} />
        </Row>
        <Row label="Charged to the total">{c.charged}</Row>
        <Row label="Overlapped another run" mono={false}>
          {c.overlapped ? "Yes" : "No"}
        </Row>
      </dl>
      <p className={cn("mt-2 text-body-small", muted)}>
        {c.overlapped
          ? "Another measured run shared this span, so both read the same drop in the account balance; the total charges this run's estimate instead."
          : r.state === "running" || r.state === "stalled"
            ? "An open run charges nothing until it finishes."
            : "The total charges the measurement when there is one, the estimate otherwise."}
      </p>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border-faint px-4 py-4">
      <h3 className={cn("mb-2.5 text-mono-x-small", faint)}>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children, mono = true }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 py-1">
      <dt className={cn("truncate text-body-small", muted)}>{label}</dt>
      <dd className={cn("text-right", mono ? "text-mono-small" : "text-body-small")}>{children}</dd>
    </div>
  );
}

/** Everything the row stored, in one place: timing, every count, the three credit figures (for a viewer who sees spend), the id, and the full error. */
function RunDetail({ r }: { r: RunView }) {
  // Alphabetical: Postgres hands jsonb keys back shortest first, which reads as no order at all.
  const counts = Object.entries(r.counts ?? {}).sort(([a], [b]) => countLabel(a).localeCompare(countLabel(b)));
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(r.id);
      toast.success("Run id copied");
    } catch {
      toast.error("Could not copy the run id");
    }
  };

  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <SheetTitle className="truncate text-title-h6">
            <LaneName r={r} />
          </SheetTitle>
          <StateTag r={r} />
        </div>
        <SheetDescription>{r.preset ?? "Run detail"}</SheetDescription>
      </SheetHeader>

      {r.state === "stalled" && r.stalledNote && <p className="px-4 pb-4 text-body-small text-honey-ink">{r.stalledNote}</p>}

      {r.error && (
        <Section title="ERROR">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-8 border border-border-faint bg-bg-lighter p-3 text-mono-small text-crimson-ink">
            {r.error}
          </pre>
        </Section>
      )}

      <Section title="TIMING">
        <dl>
          <Row label="Started">
            <Absolute iso={r.startedAt} />
          </Row>
          <Row label="Finished">
            {r.finishedAt ? (
              <Absolute iso={r.finishedAt} />
            ) : (
              <span className={muted}>{r.state === "stalled" ? "No finish recorded" : "Still running"}</span>
            )}
          </Row>
          <Row label={r.finishedAt ? "Duration" : "Elapsed"}>{r.duration}</Row>
        </dl>
      </Section>

      {r.credits && <CreditsSection r={r} c={r.credits} />}

      <Section title="COUNTS">
        {counts.length === 0 ? (
          <p className={cn("text-body-small", muted)}>No counts recorded.</p>
        ) : (
          <dl>
            {counts.map(([k, v]) => (
              <Row key={k} label={countLabel(k)}>
                {v}
              </Row>
            ))}
          </dl>
        )}
      </Section>

      <Section title="RUN ID">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-mono-small">{r.id}</code>
          <Button variant="ghost" size="icon-sm" onClick={copyId} aria-label="Copy run id" className="-mt-1 shrink-0">
            <Copy />
          </Button>
        </div>
        {r.preset && (
          <p className={cn("mt-2 text-body-small", muted)}>
            {r.credits !== null ? "Preset" : "Watchlist"} <code className="text-mono-small">{r.presetSlug}</code>
          </p>
        )}
      </Section>
    </>
  );
}
