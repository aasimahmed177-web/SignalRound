"use client";

import { Check, ExternalLink, Loader2, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { addAlias, decide, undoDecision } from "@/app/actions";
import { CompanyLogo } from "@/components/company-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import type { ActionResult } from "@/lib/action-result";
import { hostLabel, roundStageLabel } from "@/lib/format";
import type { ResearchOutcome } from "@/lib/gapfill";
import { typingIn } from "@/lib/keyboard";
import { companyHref } from "@/lib/links";
import type { RoundRow } from "@/lib/persist";
import { capitalizeFirst } from "@/lib/text";
import { cn } from "@/lib/utils";

const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/** What Research is priced at before it runs; mirrors GAP_FILL_CREDITS in lib/gapfill.ts (a server module). */
const RESEARCH_CAP = 400;
const RESEARCH_TITLE = `One bounded agent run (up to ${RESEARCH_CAP} credits) that reads the sources above and looks for the press release. Fills only what is missing.`;

/** Why the record is in the queue, one short tag each. */
function reasons(r: RoundRow): string[] {
  const out: string[] = [];
  if (!r.announced_on) out.push("undated");
  if (r.confidence < 0.5) out.push(`confidence ${r.confidence.toFixed(2)}`);
  if (r.sources.length === 1) out.push("single source");
  if (!r.amount.as_written) out.push("no amount");
  if (r.lead_investors.length === 0) out.push("no lead named");
  return out;
}

/**
 * A source URL a reader can place at a glance: the host, then the path with its middle folded
 * when it runs long (EDGAR paths carry three numeric segments before the document).
 */
function shortUrl(url: string, host: string): string {
  const h = hostLabel(host);
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const path = segments.length > 3 ? `/${segments[0]}/.../${segments[segments.length - 1]}` : u.pathname;
    return `${h}${path === "/" ? "" : path}`;
  } catch {
    return h;
  }
}

/** A quote as a reader sees it: newsletter quotes arrive as markdown, links and bold markers included. */
function plainQuote(quote: string): string {
  return quote
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function AliasForm({ r, onDone }: { r: RoundRow; onDone: () => void }) {
  const [canonical, setCanonical] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canonical.trim()) return;
        start(async () => {
          const res = await addAlias(r.company.name, canonical.trim());
          if (res.ok) {
            toast.success(`Saved: ${r.company.name} is ${canonical.trim()}`, { description: "The resolver applies it on the next run." });
            onDone();
          } else setError(res.error);
        });
      }}
    >
      <Input
        // Opened from the button or the `a` key; either way the next thing typed is the name.
        autoFocus
        value={canonical}
        onChange={(e) => setCanonical(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
        placeholder={`"${r.company.name}" is the same company as...`}
        aria-label="Canonical company name"
        className="h-8 w-full text-body-small sm:max-w-sm"
      />
      <Button type="submit" variant="outline" disabled={pending || !canonical.trim()}>
        Save alias
      </Button>
      {error && <p className="w-full text-body-small text-crimson-ink">{error}</p>}
    </form>
  );
}

const FIELD_LABEL: Record<string, string> = {
  date: "announcement date",
  amount: "amount",
  lead: "lead investor",
  investors: "other investors",
  website: "website",
  source: "a second source",
};

type Tone = "good" | "neutral" | "bad";

/** One Research run in words, without the company name: the card already says whose it is. */
function describe(o: ResearchOutcome): { tone: Tone; text: string } {
  const credits = o.creditsUsed === null ? "" : ` (${o.creditsUsed} credits)`;
  if (o.status === "failed") return { tone: "bad", text: `The agent run did not complete${credits}.` };
  if (o.status === "rumor") return { tone: "neutral", text: `The round is only reported as rumored; nothing applied${credits}.` };
  if (o.status !== "completed") return { tone: "neutral", text: `No page confirms the round; nothing applied${credits}.` };
  const filled = o.filled.map((f) => (f === "date" && o.announced_on ? `announcement date (${o.announced_on})` : (FIELD_LABEL[f] ?? f)));
  const what = filled.length ? `Filled ${filled.join(", ")}` : "Found nothing the record lacked";
  const score = `confidence ${o.confidence.before.toFixed(2)} to ${o.confidence.after.toFixed(2)}`;
  const moved =
    o.disposition.after !== o.disposition.before
      ? o.disposition.after === "review"
        ? ""
        : `, moved to the feed as ${o.disposition.after}`
      : filled.length
        ? ", still in review"
        : "";
  return { tone: filled.length ? "good" : "neutral", text: `${what}; ${score}${moved}${credits}.` };
}

/**
 * Research goes through a route handler, not a server action: Next runs a client's actions one at
 * a time, so a minutes-long run as an action would queue every Publish and Reject behind it.
 */
async function postResearch(id: string): Promise<ActionResult<{ value: ResearchOutcome }>> {
  const res = await fetch("/review/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = (await res.json().catch(() => null)) as ActionResult<{ value: ResearchOutcome }> | null;
  if (body && typeof body.ok === "boolean") return body;
  return { ok: false, error: `The research request failed (HTTP ${res.status}).` };
}

type ResearchState = { phase: "running"; since: number } | { phase: "done"; tone: Tone; text: string };

/** Seconds since a run started, so a long agent call reads as alive rather than stuck. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="text-mono-small">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`}</span>;
}

function ResearchNote({ r, state, onDismiss }: { r: RoundRow; state: ResearchState; onDismiss: () => void }) {
  if (state.phase === "running") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-8 border border-heat-20 bg-heat-4 px-3 py-2 text-body-small">
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-heat-100" aria-hidden />
        <span className="min-w-0 flex-1">
          Researching: reading {r.sources.length} source{r.sources.length === 1 ? "" : "s"} and looking for the press release. Usually about
          a minute.
        </span>
        <span className={cn("shrink-0", SECONDARY)}>
          <Elapsed since={state.since} />
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-8 border px-3 py-2 text-body-small",
        state.tone === "good" && "border-heat-20 bg-heat-4",
        state.tone === "neutral" && "border-border-faint bg-black-alpha-4",
        state.tone === "bad" && "border-accent-crimson/30 bg-accent-crimson/5",
      )}
    >
      <Sparkles
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          state.tone === "bad" ? "text-crimson-ink" : state.tone === "good" ? "text-heat-ink" : SECONDARY,
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">{state.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the research result"
        className={cn("-m-1 shrink-0 rounded-4 p-1 hover:text-foreground", SECONDARY)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-4 border border-border-faint bg-card px-1 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

/** The shortcuts, once, above the list. Keyboard people only: hidden on narrow and touch screens. */
function ShortcutHint() {
  const keys: Array<[string, string]> = [
    ["j k", "move"],
    ["p", "publish"],
    ["r", "reject"],
    ["e", "research"],
    ["a", "same company"],
  ];
  return (
    <p className={cn("hidden flex-wrap items-center gap-x-4 gap-y-1 text-body-small md:flex pointer-coarse:hidden", SECONDARY)}>
      {keys.map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          {k.split(" ").map((c) => (
            <Kbd key={c}>{c}</Kbd>
          ))}
          {label}
        </span>
      ))}
    </p>
  );
}

export function ReviewList({ rows }: { rows: RoundRow[] }) {
  const router = useRouter();
  // Rows decided here and not yet undone. The server drops them too; this hides them before it answers.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // Per row, so a run on one card never disables another.
  const [research, setResearch] = useState<Record<string, ResearchState>>({});
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // The focus ring is for keyboard triage; a click focuses the card without painting it.
  const [keyboard, setKeyboard] = useState(false);
  const cards = useRef(new Map<string, HTMLLIElement>());
  // A decision still in flight, so an Undo pressed early waits for it (and skips if it failed).
  const decisions = useRef(new Map<string, Promise<boolean>>());

  const visible = rows.filter((r) => !hidden.has(r.id));

  const setHiddenFor = (id: string, hide: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });

  const setResearchFor = (id: string, state: ResearchState | null) =>
    setResearch((prev) => {
      const next = { ...prev };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });

  const focusCard = (id: string | null, scroll = true) => {
    setFocused(id);
    if (!id) return;
    const el = cards.current.get(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (scroll) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  };

  const undo = async (r: RoundRow, from: "publish" | "rejected") => {
    if ((await decisions.current.get(r.id)) === false) return;
    const res = await undoDecision(r.id, from);
    if (!res.ok) {
      toast.error(`Could not undo ${r.company.name}`, { description: res.error });
      return;
    }
    setHiddenFor(r.id, false);
    setFocused(r.id);
    toast(`${r.company.name} is back in review`);
  };

  const decideRow = (r: RoundRow, disposition: "publish" | "rejected") => {
    if (research[r.id]?.phase === "running") return;
    // The card leaves now; the next one takes the focus so triage keeps its place.
    const at = visible.findIndex((x) => x.id === r.id);
    const neighbour = visible[at + 1] ?? visible[at - 1] ?? null;
    const holdsFocus = focused === r.id || cards.current.get(r.id)?.contains(document.activeElement);
    setHiddenFor(r.id, true);
    if (aliasFor === r.id) setAliasFor(null);
    if (holdsFocus) focusCard(neighbour?.id ?? null);

    const verb = disposition === "publish" ? "Published" : "Rejected";
    const toastId = toast.success(`${verb} ${r.company.name}`, {
      description: disposition === "publish" ? "It is in the feed now." : "It stays out of the feed and off the next run's queue.",
      action: { label: "Undo", onClick: () => void undo(r, disposition) },
    });
    const done = decide(r.id, disposition).then(
      (res) => {
        if (res.ok) return true;
        setHiddenFor(r.id, false);
        toast.error(`Could not ${disposition === "publish" ? "publish" : "reject"} ${r.company.name}`, {
          id: toastId,
          description: res.error,
          action: undefined,
        });
        return false;
      },
      (err: unknown) => {
        setHiddenFor(r.id, false);
        toast.error(`Could not ${disposition === "publish" ? "publish" : "reject"} ${r.company.name}`, {
          id: toastId,
          description: err instanceof Error ? err.message : String(err),
          action: undefined,
        });
        return false;
      },
    );
    decisions.current.set(r.id, done);
    void done.finally(() => {
      if (decisions.current.get(r.id) === done) decisions.current.delete(r.id);
    });
  };

  const runResearch = async (r: RoundRow) => {
    if (research[r.id]?.phase === "running") return;
    setResearchFor(r.id, { phase: "running", since: Date.now() });
    let res: ActionResult<{ value: ResearchOutcome }>;
    try {
      res = await postResearch(r.id);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      setResearchFor(r.id, { phase: "done", tone: "bad", text: res.error });
      toast.error(`Research on ${r.company.name} failed`, { description: res.error });
      return;
    }
    const { tone, text } = describe(res.value);
    setResearchFor(r.id, { phase: "done", tone, text });
    if (tone === "bad") toast.error(`Research on ${r.company.name}`, { description: text });
    else if (tone === "good") toast.success(`Research on ${r.company.name}`, { description: text });
    else toast(`Research on ${r.company.name}`, { description: text });
    // The route marked the pages stale; the router only sees it on a refresh.
    if (res.value.status === "completed") router.refresh();
  };

  /** The keyboard path to Research asks first: one stray key should not spend 400 credits. */
  const confirmResearch = (r: RoundRow) => {
    if (research[r.id]?.phase === "running") return;
    toast(`Research ${r.company.name}?`, {
      description: `One agent run, up to ${RESEARCH_CAP} credits. Fills only what is missing.`,
      action: { label: "Run", onClick: () => void runResearch(r) },
    });
  };

  // One listener for the page's life; it reads the latest render through the ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typingIn(e.target)) return;
    const key = e.key;
    if (!["j", "k", "p", "r", "e", "a"].includes(key) || visible.length === 0) return;
    e.preventDefault();
    setKeyboard(true);
    const at = visible.findIndex((x) => x.id === focused);
    if (key === "j" || key === "k") {
      if (e.repeat && at === -1) return;
      const next = at === -1 ? 0 : Math.min(Math.max(at + (key === "j" ? 1 : -1), 0), visible.length - 1);
      focusCard(visible[next].id);
      return;
    }
    if (e.repeat) return;
    const r = visible[at];
    if (!r) {
      focusCard(visible[0].id);
      return;
    }
    if (key === "p") decideRow(r, "publish");
    else if (key === "r") decideRow(r, "rejected");
    else if (key === "e") confirmResearch(r);
    else if (key === "a") setAliasFor(aliasFor === r.id ? null : r.id);
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (visible.length === 0) {
    return (
      <div className={cn("rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small", SECONDARY)}>
        The queue is clear. Records land here when they are undated or score below 0.50.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ShortcutHint />
      <ul className="space-y-4">
        {visible.map((r) => {
          const state = research[r.id];
          const busy = state?.phase === "running";
          const meta = `${roundStageLabel(r)} · ${r.amount.as_written ?? "amount not stated"} · ${r.announced_on ?? "undated"}`;
          return (
            <li
              key={r.id}
              ref={(el) => {
                if (el) cards.current.set(r.id, el);
                else cards.current.delete(r.id);
              }}
              tabIndex={-1}
              aria-label={`${r.company.name}, ${meta}`}
              aria-busy={busy || undefined}
              onPointerDown={() => {
                setKeyboard(false);
                setFocused(r.id);
              }}
              onFocus={() => setFocused(r.id)}
              className={cn(
                "scroll-my-6 rounded-12 border bg-card outline-none transition-shadow",
                busy ? "border-heat-40" : "border-border-faint",
                keyboard && focused === r.id && "ring-2 ring-heat-40 ring-offset-2 ring-offset-background",
              )}
            >
              <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:gap-6 sm:p-5">
                <div className="min-w-0 flex-1 space-y-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <CompanyLogo id={r.company.id} name={r.company.name} domain={r.company.domain} logoUrl={r.company.logo_url} size={22} />
                    <Link href={companyHref(r.company.id)} className="truncate text-label-medium hover:underline">
                      {r.company.name}
                    </Link>
                    <span className={cn("hidden truncate text-body-small tabular-nums sm:block", SECONDARY)}>{meta}</span>
                  </div>
                  <div className={cn("text-body-small tabular-nums sm:hidden", SECONDARY)}>{meta}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {reasons(r).map((why) => (
                      <Tag key={why} tone="honey">
                        {why}
                      </Tag>
                    ))}
                  </div>
                  {r.company.description && <p className={cn("text-body-small", SECONDARY)}>{capitalizeFirst(r.company.description)}</p>}
                  {r.evidence_quotes[0] && (
                    <blockquote className={cn("border-l-2 border-heat-40 pl-3 text-body-small [overflow-wrap:anywhere]", SECONDARY)}>
                      {plainQuote(r.evidence_quotes[0])}
                    </blockquote>
                  )}
                  <ul className="space-y-1">
                    {r.sources.map((s) => (
                      <li key={s.url} className="min-w-0">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s.url}
                          className="group flex min-w-0 items-baseline gap-2 text-body-small"
                        >
                          <ExternalLink className={cn("size-3 shrink-0 translate-y-0.5", SECONDARY)} aria-hidden />
                          {s.title ? (
                            <>
                              <span className="line-clamp-2 min-w-0 group-hover:underline sm:line-clamp-none sm:truncate">{s.title}</span>
                              <span className={cn("max-w-[40%] shrink-0 truncate", SECONDARY)}>{hostLabel(s.host)}</span>
                            </>
                          ) : (
                            <span className={cn("min-w-0 truncate group-hover:underline", SECONDARY)}>{shortUrl(s.url, s.host)}</span>
                          )}
                        </a>
                      </li>
                    ))}
                  </ul>
                  {state && <ResearchNote r={r} state={state} onDismiss={() => setResearchFor(r.id, null)} />}
                  {aliasFor === r.id && (
                    <AliasForm
                      r={r}
                      onDone={() => {
                        setAliasFor(null);
                        focusCard(r.id, false);
                      }}
                    />
                  )}
                </div>
                {/* One primary per card; the rest share its width so the stack reads as one control. On a phone
                    Publish spans the row and Reject and Research sit side by side, so the stack stays short. */}
                <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:flex sm:w-40 sm:flex-col">
                  <Button
                    size="sm"
                    className="col-span-2 h-9 w-full sm:h-7"
                    disabled={busy}
                    aria-keyshortcuts="p"
                    onClick={() => decideRow(r, "publish")}
                  >
                    <Check className="size-3.5" /> Publish
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full sm:h-7"
                    disabled={busy}
                    aria-keyshortcuts="r"
                    onClick={() => decideRow(r, "rejected")}
                  >
                    <X className="size-3.5" /> Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full sm:h-7"
                    disabled={busy}
                    title={RESEARCH_TITLE}
                    aria-keyshortcuts="e"
                    onClick={() => void runResearch(r)}
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    {busy ? "Researching..." : "Research"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn("col-span-2 h-9 w-full sm:h-7", SECONDARY)}
                    aria-expanded={aliasFor === r.id}
                    aria-keyshortcuts="a"
                    onClick={() => setAliasFor(aliasFor === r.id ? null : r.id)}
                  >
                    Same company as
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
