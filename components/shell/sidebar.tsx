"use client";

import { ArrowUpRight, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { FlameMark } from "@/components/brand/flame-mark";
import { openCommandPalette, useModKey } from "@/components/search/command-palette";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { track } from "@/lib/analytics";
import { type NavItem, navIndex, navItemsFor } from "@/lib/nav";
import { cn } from "@/lib/utils";

export { shellIconButton, ThemeToggle } from "@/components/shell/theme-toggle";

/**
 * Flame mark plus the two-line wordmark; the sidebar head and the mobile top bar share it. With
 * `href` (LANDING=1 passes `/`) it is a link back to the landing page.
 */
export function Brand({ href }: { href?: string }) {
  const inner = (
    <>
      {/* The lit mark on its own, no ground: the brand rule is that the flame is never boxed or recolored. */}
      <FlameMark size="lg" live className="-ml-1 size-8" />
      <div className="leading-none">
        <div className="text-label-medium">Fireround</div>
        <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">funding feed</div>
      </div>
    </>
  );
  if (!href) return <div className="flex items-center gap-2.5">{inner}</div>;
  return (
    <Link
      href={href}
      aria-label="Fireround home"
      className="flex items-center gap-2.5 rounded-8 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {inner}
    </Link>
  );
}

/** The rail's search field: a button dressed as an input that opens the command palette, with its shortcut. */
export function SearchTrigger() {
  const mod = useModKey();
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-8 w-full items-center gap-2 rounded-8 bg-black-alpha-4 px-2.5 text-label-small text-black-alpha-56 transition-colors hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6 dark:text-muted-foreground dark:hover:bg-white/10"
    >
      <Search className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="flex-1 text-left">Search</span>
      <kbd className="font-mono text-[11px] tracking-wide text-black-alpha-40 dark:text-muted-foreground">{mod}K</kbd>
    </button>
  );
}

interface NavLinksProps {
  /** The sections the viewer sees, in the sidebar's order. */
  items: NavItem[];
  active: number | null;
  /** The drawer passes this so it can close as soon as a link is chosen. */
  onNavigate?: () => void;
}

export function NavLinks({ items, active, onNavigate }: NavLinksProps) {
  return (
    <nav aria-label="Sections" className="flex-1 space-y-0.5 p-3">
      {items.map((item, i) => {
        const isActive = i === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-8 px-3 py-2 text-label-medium transition-colors",
              isActive
                ? "bg-black-alpha-4 text-foreground dark:bg-white/6"
                : "text-black-alpha-56 hover:bg-black-alpha-4 hover:text-foreground dark:text-muted-foreground dark:hover:bg-white/6",
            )}
          >
            {isActive && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-heat-100" aria-hidden />}
            <Icon className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** The pathname is the one thing here that is runtime data on a page with a dynamic param. */
function ActiveNavLinks({ items, onNavigate }: Pick<NavLinksProps, "items" | "onNavigate">) {
  const pathname = usePathname();
  return <NavLinks items={items} active={navIndex(pathname, items)} onNavigate={onNavigate} />;
}

/** Nav links with the active tick streamed in behind a Suspense boundary. */
export function SuspendedNavLinks({ items, onNavigate }: Pick<NavLinksProps, "items" | "onNavigate">) {
  return (
    // Under /companies/[id] and /investors/[id] the pathname is unknown at prerender, so the active tick streams in.
    <Suspense fallback={<NavLinks items={items} active={null} onNavigate={onNavigate} />}>
      <ActiveNavLinks items={items} onNavigate={onNavigate} />
    </Suspense>
  );
}

const footerLink =
  "inline-flex items-center gap-1 text-label-small text-black-alpha-56 transition-colors hover:text-foreground dark:text-muted-foreground";

export function SidebarFooter({ signIn = false }: { signIn?: boolean }) {
  return (
    <div className="flex items-center gap-4 border-t border-border-faint px-4 py-3">
      <Link href="/docs" className={footerLink} onClick={() => track("fireround_api_docs_opened", { location: "sidebar", target: "docs" })}>
        API
      </Link>
      <a
        href="https://github.com/firecrawl/fireround"
        target="_blank"
        rel="noreferrer"
        className={footerLink}
        onClick={() => track("fireround_github_clicked", { location: "sidebar" })}
      >
        Open source
        <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden />
      </a>
      {signIn && (
        // The proxy challenges on /settings, and the browser then sends the credentials origin-wide.
        // No prefetch: a background request for /settings would pop the sign-in dialog unasked.
        <Link href="/settings" prefetch={false} className={footerLink}>
          Sign in
        </Link>
      )}
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </div>
  );
}

interface ShellProps {
  /** The section hrefs the viewer sees, in order; unset renders the full nav. */
  hrefs?: string[];
  /** Demo mode for a visitor: the footer adds a way into the admin tier. */
  signIn?: boolean;
  /** Where the brand links; set when LANDING=1 puts the landing page at `/`. */
  home?: string;
}

/** The desktop rail. Below `lg` the MobileNav top bar takes over; CSS decides which one shows. */
export function Sidebar({ hrefs, signIn, home }: ShellProps) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col self-start overflow-y-auto border-r border-border-faint bg-sidebar lg:flex">
      <div className="flex h-14 items-center border-b border-border-faint px-5">
        <Brand href={home} />
      </div>
      <div className="px-3 pt-3">
        <SearchTrigger />
      </div>
      <SuspendedNavLinks items={navItemsFor(hrefs)} />
      <SidebarFooter signIn={signIn} />
    </aside>
  );
}
