import { ArrowUpRight, ChevronRight } from "lucide-react";
import Link from "next/link";
import { FlameMark } from "@/components/brand/flame-mark";
import { stageOf, usd } from "@/lib/format";
import { houseHeadline } from "@/lib/house";
import { companyHref } from "@/lib/links";
import type { FeedRow } from "@/lib/persist";
import { cn } from "@/lib/utils";

/**
 * The house round, featured above the feed while it is fresh: the lit flame, the sentence, and why
 * it is here ("the company this feed is built on"), with a link to the company page, where the
 * publishers that reported it are listed. It is the screen's orange moment, so the flame is the only heat in it; the rest is
 * ink and hairline. One line on a desktop; on a phone the whole strip is one link to the company.
 * `embedded` drops the card so the demo hero can carry it as its first row.
 */
export function HouseBanner({ r, embedded = false }: { r: FeedRow; embedded?: boolean }) {
  const { lead, figure, rest, by } = houseHeadline({
    name: r.company.name,
    amount: usd(r.amount.usd_millions),
    stage: stageOf(r),
    leads: r.lead_investors,
  });
  const href = companyHref(r.company.id);
  return (
    <section
      aria-label={`${r.company.name}, the company this feed is built on`}
      className={cn("relative", !embedded && "overflow-hidden rounded-12 border border-border-faint bg-card")}
    >
      {/* The one accent besides the flame: a heat hairline that fades out along the top edge. */}
      <span className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-heat-64 via-heat-16 to-transparent" aria-hidden />
      <div className="flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5">
        <FlameMark live size="inherit" className="size-6 sm:size-7" />
        <div className="min-w-0 flex-1">
          {/* Below md the headline's ::after covers the strip, so a tap anywhere opens the company. */}
          <Link
            href={href}
            className="block rounded-4 text-label-medium text-foreground outline-none after:absolute after:inset-0 hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:after:hidden"
          >
            {lead}
            {figure && <span className="font-mono tabular-nums">{figure}</span>}
            {rest}
            {/* A phone keeps the sentence to one line; the leads are on the company page it opens. */}
            <span className="hidden sm:inline">{by}</span>
          </Link>
          <p className="text-body-small text-muted-foreground">
            The company this feed is built on.
            <span className="hidden lg:inline"> Every round here was found and read with its API.</span>
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" aria-hidden />
        <div className="hidden shrink-0 items-center text-body-small md:flex">
          <Link
            href={href}
            className="inline-flex items-center gap-1 rounded-4 text-label-small text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open company <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
