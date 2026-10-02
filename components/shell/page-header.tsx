import type { ReactNode } from "react";
import { FirecrawlLockup } from "@/components/brand/firecrawl-lockup";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Index into NAV; supplies the title and description a page does not set itself. */
  section: number;
  /** A node so a page can stream a title that depends on the URL (the feed's) inside Suspense. */
  title?: ReactNode;
  description?: ReactNode;
  /** A trail above the title for pages below a section (Feed / Companies / Acme). */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}

/**
 * The title block every page opens with. On a phone the title steps down a size and the
 * description holds to two lines, so the page itself starts on the first screen. The title wraps
 * rather than truncating: beside the actions at tablet widths a long name or the feed's title lost
 * its end to an ellipsis. The Firecrawl
 * lockup takes the top-right corner on the widths that show the desktop sidebar; the phone
 * carries it in the drawer instead.
 */
export function PageHeader({ section, title, description, breadcrumb, actions }: PageHeaderProps) {
  const item = NAV[section];
  return (
    <header className="border-b border-border-faint bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:flex-row sm:justify-between sm:gap-6 sm:py-6 lg:px-8">
        <div className="min-w-0 flex-1">
          {breadcrumb && <div className="mb-1 truncate text-body-small text-muted-foreground">{breadcrumb}</div>}
          <h1 className="text-title-h5 text-balance [overflow-wrap:anywhere] sm:text-title-h4">{title ?? item?.label}</h1>
          <p className="mt-1 line-clamp-2 text-body-small text-muted-foreground sm:line-clamp-none sm:text-body-medium">
            {description ?? item?.description}
          </p>
        </div>
        {/* Lockup on top, actions at the foot of the title block; below lg the column only exists for actions. */}
        <div className={cn("flex-col items-start gap-3 sm:shrink-0 sm:items-end sm:justify-between", actions ? "flex" : "hidden lg:flex")}>
          <FirecrawlLockup className="hidden lg:inline-flex" />
          {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
        </div>
      </div>
    </header>
  );
}
