import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { pageList, pageSpan } from "@/lib/pages";
import { groupDigits } from "@/lib/text";
import { cn } from "@/lib/utils";

interface PagerProps {
  page: number;
  count: number;
  total: number;
  size: number;
  /** The feed URL for a page, carrying every filter and the sort. */
  hrefFor: (page: number) => string;
}

const STEP = "tap relative flex h-8 items-center gap-1 rounded-full px-3 text-label-small transition-colors";

/** Previous or Next: a real link while there is somewhere to go, a quiet label at the end. */
function Step({ href, label, dir }: { href: string | null; label: string; dir: "prev" | "next" }) {
  const body = (
    <>
      {dir === "prev" && <ChevronLeft className="size-3.5" />}
      {label}
      {dir === "next" && <ChevronRight className="size-3.5" />}
    </>
  );
  if (!href) {
    return (
      <span aria-disabled className={cn(STEP, "text-black-alpha-32 dark:text-muted-foreground/50")}>
        {body}
      </span>
    );
  }
  return (
    <Link href={href} rel={dir} className={cn(STEP, "text-foreground hover:bg-black-alpha-4 dark:hover:bg-white/6")}>
      {body}
    </Link>
  );
}

/**
 * Numbered pages under the feed. Every page is a plain link, so the back button and a shared URL
 * both land on the same rows. Desktop shows the numbers (first, last, and the current page's
 * neighbours, ink-filled like an active chip); a phone swaps them for "Page 2 of 7".
 */
export function Pager({ page, count, total, size, hrefFor }: PagerProps) {
  if (count <= 1) return null;
  const { from, to } = pageSpan(page, size, total);
  return (
    <nav aria-label="Pages" className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
      <p className="order-last text-body-small text-muted-foreground sm:order-first">
        Showing{" "}
        <span className="font-mono text-foreground tabular-nums">
          {groupDigits(from)} to {groupDigits(to)}
        </span>{" "}
        of <span className="font-mono text-foreground tabular-nums">{groupDigits(total)}</span>
      </p>
      <div className="flex items-center gap-1">
        <Step href={page > 1 ? hrefFor(page - 1) : null} label="Previous" dir="prev" />
        <span className="px-2 text-body-small text-muted-foreground sm:hidden">
          Page <span className="font-mono text-foreground tabular-nums">{page}</span> of{" "}
          <span className="font-mono text-foreground tabular-nums">{count}</span>
        </span>
        <ol className="hidden items-center gap-1 sm:flex">
          {pageList(page, count).map((n, i) =>
            n === "gap" ? (
              // Two gaps at most, and never adjacent, so the index keeps them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: gaps have no identity of their own
              <li key={`gap-${i}`} aria-hidden className="w-6 text-center font-mono text-body-small text-muted-foreground">
                …
              </li>
            ) : (
              <li key={n}>
                <Link
                  href={hrefFor(n)}
                  aria-label={`Page ${n}`}
                  aria-current={n === page ? "page" : undefined}
                  className={cn(
                    "flex h-8 min-w-8 items-center justify-center rounded-full px-2 font-mono text-label-small tabular-nums transition-colors",
                    n === page
                      ? "bg-foreground text-background"
                      : "text-black-alpha-56 hover:bg-black-alpha-4 hover:text-foreground dark:text-muted-foreground dark:hover:bg-white/6",
                  )}
                >
                  {n}
                </Link>
              </li>
            ),
          )}
        </ol>
        <Step href={page < count ? hrefFor(page + 1) : null} label="Next" dir="next" />
      </div>
    </nav>
  );
}
