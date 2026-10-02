import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { FirecrawlLockup } from "@/components/brand/firecrawl-lockup";
import { DataNotice } from "@/components/feed/data-notice";
import { container, gutter } from "@/components/marketing/section";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { isPublicDemo } from "@/lib/access";
import { REPO_URL } from "@/lib/landing";
import { cn } from "@/lib/utils";

type FooterLink = { href: string; label: string; external?: boolean };

/** The public feed URL only answers in demo mode (a private instance mints tokens), so the link follows the mode. */
const columns = (demo: boolean): Array<{ title: string; links: FooterLink[] }> => [
  {
    title: "Product",
    links: [
      { href: "/feed", label: "Live feed" },
      { href: "/overview", label: "Market overview" },
      { href: "/companies", label: "Companies" },
      { href: "/investors", label: "Investors" },
      { href: "/news", label: "News" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/api/v1/openapi.json", label: "API reference", external: true },
      { href: "#api", label: "MCP server" },
      ...(demo ? [{ href: "/feeds/public/all.rss", label: "RSS feed", external: true }] : []),
      { href: "https://docs.firecrawl.dev", label: "Firecrawl docs", external: true },
    ],
  },
  {
    title: "Project",
    links: [
      { href: REPO_URL, label: "GitHub", external: true },
      { href: `${REPO_URL}/blob/main/docs/how-it-works.md`, label: "How it works", external: true },
      { href: `${REPO_URL}/blob/main/docs/data-quality.md`, label: "Data quality", external: true },
      { href: `${REPO_URL}/blob/main/LICENSE`, label: "MIT license", external: true },
      { href: "/support", label: "Support" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

const link =
  "tap relative inline-flex items-center gap-1 rounded-4 text-body-small text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The foot: the lockup and what Fireround is, three short columns of links, the data notice and the
 * theme. `anchorBase` prefixes the landing page's own anchors when the foot sits on another page.
 */
export function SiteFooter({ anchorBase = "" }: { anchorBase?: string }) {
  return (
    <footer className="border-border-faint">
      <div
        className={cn(
          container,
          gutter,
          "grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] lg:gap-8",
        )}
      >
        <div className="space-y-4">
          <div className="text-[17px] leading-none font-medium tracking-[-0.01em]">Fireround</div>
          <p className="max-w-xs text-body-small text-muted-foreground">
            The open-source funding feed, and a Firecrawl example app. Fork it and run it on your own key.
          </p>
          <FirecrawlLockup className="pt-1" />
        </div>
        {columns(isPublicDemo()).map((col) => (
          <nav key={col.title} aria-label={col.title} className="space-y-3">
            <p className="text-mono-x-small text-black-alpha-32">{col.title}</p>
            <ul className="space-y-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.external ? (
                    <a href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={link}>
                      {l.label}
                      {l.href.startsWith("http") && <ArrowUpRight className="size-3 opacity-60" aria-hidden />}
                    </a>
                  ) : l.href.startsWith("#") ? (
                    <a href={`${anchorBase}${l.href}`} className={link}>
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className={link}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-border-faint">
        {/* The data notice wraps on a phone, so the bar grows with it; the licence lives in the Project column. */}
        <div className={cn(container, gutter, "flex min-h-14 items-center justify-between gap-4 py-3")}>
          <DataNotice />
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
