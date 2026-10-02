"use client";

import { ArrowUpRight, CornerDownLeft, Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { searchEntities } from "@/app/(dashboard)/search/actions";
import { RequestCompanyDialog } from "@/components/company/request-company-dialog";
import { CompanyLogo } from "@/components/company-logo";
import { InvestorLogo } from "@/components/investor-logo";
import { type PaletteOption, paletteOptions } from "@/components/search/palette-items";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { websiteFromQuery } from "@/lib/company-request-ui";
import type { SearchHit } from "@/lib/directory";
import { navItemsFor } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** The shell's triggers and the palette are siblings under the layout; a window event joins them without a provider. */
const OPEN_EVENT = "fireround:command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const NO_HITS: { companies: SearchHit[]; investors: SearchHit[] } = { companies: [], investors: [] };

/** Keystrokes settle this long before the server is asked. */
const DEBOUNCE_MS = 180;

const subscribeNever = () => () => {};

/** "⌘" on Apple platforms, "Ctrl" elsewhere. The server renders ⌘ and the client corrects it after hydration. */
export function useModKey(): string {
  return useSyncExternalStore(
    subscribeNever,
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl "),
    () => "⌘",
  );
}

function OptionLead({ option }: { option: PaletteOption }) {
  const box = "grid size-6 shrink-0 place-items-center text-black-alpha-56 dark:text-muted-foreground";
  if (option.lead.kind === "company") {
    const { hit } = option.lead;
    return (
      <span className={box}>
        <CompanyLogo id={hit.id} name={hit.name} domain={hit.domain} logoUrl={hit.logo_url} size={20} />
      </span>
    );
  }
  if (option.lead.kind === "investor") {
    const { hit } = option.lead;
    return (
      <span className={box}>
        <InvestorLogo id={hit.id} name={hit.name} domain={hit.domain} logoUrl={hit.logo_url} size={20} />
      </span>
    );
  }
  const Icon = option.lead.kind === "section" ? option.lead.item.icon : Search;
  return (
    <span className={box}>
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}

interface CommandPaletteProps {
  /** The section hrefs the viewer sees, as the sidebar gets them; unset offers every section. */
  hrefs?: string[];
  requestsEnabled?: boolean;
}

/**
 * ⌘K / Ctrl+K from anywhere in the dashboard: sections the viewer can open, then companies and
 * investors by name, looked up on the server as the reader types. The input stays focused
 * throughout (a combobox driving a listbox through aria-activedescendant), so arrows move, Enter
 * opens, and Escape closes; Radix returns focus to whatever opened it.
 */
export function CommandPalette({ hrefs, requestsEnabled = false }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestWebsite, setRequestWebsite] = useState("");
  const [q, setQ] = useState("");
  /** The last reply and the term it answers; while the reader types past it, its hits are stale. */
  const [result, setResult] = useState({ term: "", hits: NO_HITS });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Opened by a shortcut or a window event there is no DialogTrigger to hand focus back to, so the palette remembers. */
  const returnFocus = useRef<HTMLElement | null>(null);
  /** The window listeners mount once and read the current state through this. */
  const openRef = useRef(open);
  openRef.current = open;
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const term = q.trim();
  const options = paletteOptions(navItemsFor(hrefs), q, result.hits, requestsEnabled);
  // The previous query's hits stay on screen (dimmed) so the list does not flicker per keystroke,
  // but they cannot be opened until the reply for what is typed now arrives: Enter on "Acme" must
  // not open the "Ac" answer's first company. Sections and the feed hand-off match the live term.
  const outdated = loading || result.term !== term;
  const unready = (o: PaletteOption) => outdated && (o.lead.kind === "company" || o.lead.kind === "investor");

  useEffect(() => {
    // Every opening starts clean: no query left over from the last visit.
    const show = () => {
      if (openRef.current) return;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQ("");
      setResult({ term: "", hits: NO_HITS });
      setActive(0);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openRef.current) setOpen(false);
        else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  // A reply for a query the reader has already typed past is dropped: the cleanup marks it stale.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResult({ term: "", hits: NO_HITS });
      setLoading(false);
      return;
    }
    setLoading(true);
    let stale = false;
    const timer = setTimeout(() => {
      searchEntities(term)
        .then((r) => {
          if (stale) return;
          // A new result set starts at its first option.
          setResult({ term, hits: r });
          setActive(0);
        })
        .catch(() => {
          if (!stale) setResult({ term, hits: NO_HITS });
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (option: PaletteOption | undefined) => {
    if (!option || unready(option)) return;
    if (option.lead.kind === "request") {
      setRequestWebsite(websiteFromQuery(term));
      setOpen(false);
      setRequestOpen(true);
      return;
    }
    setOpen(false);
    router.push(option.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(options[active]);
    }
  };

  const searched = term !== "" && !outdated;
  const noEntities = searched && result.hits.companies.length === 0 && result.hits.investors.length === 0;
  const groups = [...new Set(options.map((o) => o.group))];
  const activeOption = options[active];

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // After choosing a result the next page takes focus; otherwise go back to where the reader was.
            // Opened by the shortcut with nothing focused, "where the reader was" is the body, which drops a
            // keyboard reader at the top of the tab order; the page's main region is the nearer place.
            const back = returnFocus.current?.isConnected && returnFocus.current !== document.body ? returnFocus.current : null;
            const target = back ?? document.getElementById("content");
            if (!target) return;
            e.preventDefault();
            target.focus();
          }}
          className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">
            Jump to a section, a company, or an investor. Use the arrow keys to move and Enter to open.
          </DialogDescription>
          {/* The input draws no box of its own, so the row shows focus: a heat rule along its foot. */}
          <div className="flex items-center gap-2.5 border-b border-border-faint px-4 focus-within:shadow-[inset_0_-2px_0_var(--ring)]">
            {loading ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-black-alpha-32 dark:text-muted-foreground" aria-hidden />
            ) : (
              <Search className="size-4 shrink-0 text-black-alpha-32 dark:text-muted-foreground" aria-hidden />
            )}
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOption ? optionId(active) : undefined}
              aria-label="Search sections, companies, and investors"
              placeholder="Search companies, investors, sections"
              autoComplete="off"
              spellCheck={false}
              className="h-12 min-w-0 flex-1 bg-transparent text-body-medium outline-none placeholder:text-black-alpha-40 dark:placeholder:text-muted-foreground"
            />
            <kbd className="hidden rounded-4 border border-border-faint px-1.5 text-mono-x-small text-muted-foreground sm:inline">esc</kbd>
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
            {groups.map((group, g) => (
              <div key={group} role="group" aria-labelledby={`${id}-group-${g}`} className="pb-1 last:pb-0">
                <div id={`${id}-group-${g}`} className="px-2 pb-1 pt-2 text-label-x-small text-black-alpha-40 dark:text-muted-foreground">
                  {group}
                </div>
                {options.map((option, i) =>
                  option.group !== group ? null : (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keyboard; options take pointer input only.
                    <div
                      key={option.key}
                      id={optionId(i)}
                      data-index={i}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === active}
                      aria-disabled={unready(option) || undefined}
                      onMouseMove={() => i !== active && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(option)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-8 px-2 py-2",
                        i === active ? "bg-black-alpha-4 text-foreground dark:bg-white/6" : "text-foreground",
                        unready(option) && "cursor-default opacity-50",
                      )}
                    >
                      <OptionLead option={option} />
                      {/* Sections are one line (their description trails, and leaves on a phone); hits stack their detail under the name. */}
                      <span className={cn("min-w-0 flex-1", option.lead.kind === "section" && "flex items-baseline gap-3")}>
                        <span className="block shrink-0 truncate text-label-medium">{option.label}</span>
                        {option.detail && (
                          <span
                            className={cn(
                              "block truncate text-body-small text-black-alpha-56 dark:text-muted-foreground",
                              option.lead.kind === "section" && "hidden sm:block",
                            )}
                          >
                            {option.detail}
                          </span>
                        )}
                      </span>
                      {i === active &&
                        !unready(option) &&
                        (option.lead.kind === "search" ? (
                          <ArrowUpRight className="size-4 shrink-0 text-black-alpha-40" aria-hidden />
                        ) : (
                          <CornerDownLeft className="size-4 shrink-0 text-black-alpha-40" aria-hidden />
                        ))}
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
          {noEntities && (
            <p className="px-4 pb-3 text-body-small text-black-alpha-56 dark:text-muted-foreground" role="status">
              No company or investor in the feed matches "{term}".
            </p>
          )}

          <div className="hidden items-center gap-4 border-t border-border-faint px-4 py-2 text-label-x-small text-muted-foreground sm:flex">
            <span>
              <kbd className="font-mono">↑↓</kbd> to move
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> to open
            </span>
            <span>
              <kbd className="font-mono">esc</kbd> to close
            </span>
          </div>
        </DialogContent>
      </Dialog>
      {requestsEnabled && (
        <RequestCompanyDialog key={requestWebsite} initialWebsite={requestWebsite} open={requestOpen} onOpenChange={setRequestOpen} />
      )}
    </>
  );
}
