"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { WindowDots } from "@/components/marketing/code";
import { CopyButton } from "@/components/marketing/copy-button";
import { cn } from "@/lib/utils";

export interface CodeTab {
  id: string;
  label: string;
  /** Server-rendered content; every panel stays in the page, the inactive ones hidden. */
  panel: ReactNode;
  /** What Copy puts on the clipboard for this tab. */
  copy: string;
}

/**
 * A code window with tabs, as firecrawl.dev shows its SDKs: the tab row in the chrome bar, one
 * Copy for the active tab. The panels arrive rendered from the server, so the only client code is
 * the switch. Arrow keys move between tabs (the WAI-ARIA tabs pattern, automatic activation). A
 * URL hash that names a tab (`/#mcp`) opens that tab and scrolls the window into view, so a link
 * elsewhere can point at one example.
 */
export function CodeTabs({ tabs, className }: { tabs: CodeTab[]; className?: string }) {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = () => {
      const i = tabs.findIndex((t) => `#${t.id}` === window.location.hash);
      if (i < 0) return;
      setActive(i);
      frame.current?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [tabs]);
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + tabs.length) % tabs.length;
    setActive(next);
    refs.current[next]?.focus();
  };
  return (
    <div ref={frame} className={cn("min-w-0 scroll-mt-24 overflow-hidden rounded-12 border border-border-faint bg-card", className)}>
      <div className="flex h-12 items-center justify-between gap-3 border-b border-border-faint pr-2 pl-4">
        <div className="flex min-w-0 items-center gap-4">
          <WindowDots />
          <div role="tablist" aria-label="Examples" className="flex items-center gap-1" onKeyDown={onKey}>
            {tabs.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${t.id}`}
                aria-selected={i === active}
                aria-controls={`${base}-panel-${t.id}`}
                tabIndex={i === active ? 0 : -1}
                onClick={() => setActive(i)}
                className={cn(
                  "tap relative h-7 rounded-8 px-2.5 text-label-small outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  i === active ? "bg-black-alpha-4 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <CopyButton text={tabs[active]?.copy ?? ""} />
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={i !== active}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
