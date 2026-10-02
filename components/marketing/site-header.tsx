import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { FlameMark } from "@/components/brand/flame-mark";
import { GitHubMark } from "@/components/marketing/marks";
import { container, gutter } from "@/components/marketing/section";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { isLanding, LANDING_PATH } from "@/lib/access";
import { REPO_URL } from "@/lib/landing";
import { cn } from "@/lib/utils";

/** The landing page's own anchors, then the way into the product. */
const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#product", label: "Product" },
  { href: "#api", label: "API" },
  { href: "#delivery", label: "Delivery" },
  { href: "#self-host", label: "Self-host" },
];

const navLink =
  "rounded-8 px-2.5 py-1.5 text-label-medium text-black-alpha-64 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/** Where the brand goes: `/` when LANDING=1 serves the landing page there, else the page's own path. */
export function landingHome(): string {
  return isLanding() ? "/" : LANDING_PATH;
}

/**
 * The landing page's top bar: the lit flame beside the name (never boxed), the section anchors,
 * GitHub, the theme, and the feed. Sticky on a translucent ground so the rules show through it.
 * `anchorBase` prefixes the section anchors on a page that is not the landing page (the Slack pages).
 */
export function SiteHeader({ anchorBase = "" }: { anchorBase?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border-faint bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className={cn(container, gutter, "flex h-16 items-center justify-between gap-4")}>
        <Link
          href={landingHome()}
          aria-label="Fireround home"
          className="-ml-1 flex items-center gap-2 rounded-8 p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <FlameMark live size="inherit" className="size-7" />
          <span className="text-[17px] leading-none font-medium tracking-[-0.01em]">Fireround</span>
        </Link>
        <nav aria-label="Page" className="hidden items-center lg:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={`${anchorBase}${l.href}`} className={navLink}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1 sm:gap-2">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={cn(navLink, "hidden items-center gap-2 sm:inline-flex")}>
            <GitHubMark />
            <span>GitHub</span>
          </a>
          <ThemeToggle />
          <Link
            href="/feed"
            className="ml-1 inline-flex h-9 items-center gap-1.5 rounded-10 bg-foreground px-3.5 text-label-medium text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="sm:hidden">Open feed</span>
            <span className="hidden sm:inline">Open the feed</span>
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  );
}
