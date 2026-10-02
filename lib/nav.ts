import type { LucideIcon } from "lucide-react";
import { Activity, Bell, Building2, ClipboardCheck, Landmark, LayoutGrid, Newspaper, Rows3, Settings } from "lucide-react";
import type { Viewer } from "@/lib/access";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

/**
 * Pages pass an index into this list (`<PageHeader section={5} />`), so an index never changes
 * meaning: new sections are appended. The order a reader sees is DISPLAY_ORDER below. Overview
 * (0) moved from `/` to /overview when the landing page took `/`; it is still section 0.
 */
export const NAV: NavItem[] = [
  {
    href: "/overview",
    label: "Overview",
    icon: LayoutGrid,
    description: "The funding market this week: capital, the biggest rounds, stages, sectors, and who led.",
  },
  { href: "/feed", label: "Feed", icon: Rows3, description: "Every round, dated and scored, with its sources." },
  { href: "/news", label: "News", icon: Newspaper, description: "The articles behind the records." },
  { href: "/presets", label: "Presets", icon: Bell, description: "What to look for, and the monitors that look for it." },
  { href: "/runs", label: "Runs", icon: Activity, description: "Every sweep, check, and enrichment, with credits." },
  { href: "/review", label: "Review", icon: ClipboardCheck, description: "Records that need a human before they publish." },
  { href: "/settings", label: "Settings", icon: Settings, description: "Feed tokens, delivery targets, keys." },
  { href: "/companies", label: "Companies", icon: Building2, description: "Every company with a round in the feed." },
  {
    href: "/investors",
    label: "Investors",
    icon: Landmark,
    description: "Every investor named on a round in the feed, and the seat it took.",
  },
];

/** The sidebar's order: the two directories read the feed, so they sit right under it. */
const DISPLAY_ORDER = ["/overview", "/feed", "/companies", "/investors", "/news", "/presets", "/runs", "/review", "/settings"];

/** NAV in the order the sidebar shows it. */
export const NAV_DISPLAY: NavItem[] = DISPLAY_ORDER.flatMap((href) => NAV.find((n) => n.href === href) ?? []);

/** The layout hands client components hrefs (a NavItem carries a component); this maps them back, in the order given. */
export function navItemsFor(hrefs: string[] | undefined): NavItem[] {
  return hrefs ? hrefs.flatMap((h) => NAV_DISPLAY.find((n) => n.href === h) ?? []) : NAV_DISPLAY;
}

/**
 * Nav entries a demo visitor never sees: the admin paths (ADMIN_PATHS in lib/access.ts) stay
 * behind the password. Overview lives at /overview and shows only what the feed publishes to a
 * visitor, so every viewer keeps it, as they keep the directories. LANDING=1 changes nothing here:
 * the landing page took `/`, which no section uses.
 */
export function visibleNav(v: Viewer): NavItem[] {
  const hidden = v.demo && !v.admin ? ["/presets", "/review", "/settings"] : [];
  return hidden.length ? NAV_DISPLAY.filter((n) => !hidden.includes(n.href)) : NAV_DISPLAY;
}

/**
 * The entry a path belongs to, as an index into `items`: a section and everything below it
 * (`/companies/acme.com` lights Companies). `/` is the feed whenever the dashboard renders it
 * (demo mode; a private instance redirects it to /overview), so it lights Feed. -1 when nothing matches.
 */
export function navIndex(pathname: string, items: NavItem[] = NAV_DISPLAY): number {
  if (pathname === "/") return items.findIndex((n) => n.href === "/feed");
  return items.findIndex((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}
