import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The landing page's one column. From xl the column wears hairline rails down both edges and the
 * section rules run full-bleed across them, the ruled page firecrawl.dev is laid out on; below xl
 * the rails would sit on the viewport's edge, so they drop.
 */
export const container = "relative mx-auto w-full max-w-[1200px] xl:border-x xl:border-border-faint";

/** Horizontal padding inside the column: every section's left edge lands on the same line. */
export const gutter = "px-5 sm:px-8 lg:px-10";

/** A small square where a section rule crosses a rail. Decoration only. */
function Ticks() {
  return (
    <>
      <span aria-hidden className="absolute -bottom-[3px] -left-[3px] hidden size-[5px] border border-border-loud bg-background xl:block" />
      <span
        aria-hidden
        className="absolute -right-[3px] -bottom-[3px] hidden size-[5px] border border-border-loud bg-background xl:block"
      />
    </>
  );
}

/** A full-bleed band with its rule underneath, holding the railed column. */
export function Band({ id, children, className, inner }: { id?: string; children: ReactNode; className?: string; inner?: string }) {
  return (
    <section id={id} className={cn("scroll-mt-16 border-b border-border-faint", className)}>
      <div className={cn(container, inner)}>
        <Ticks />
        {children}
      </div>
    </section>
  );
}

/**
 * The strip that opens a section: a heat tick on the rail, the count, the name. The tick is the
 * section's orange moment; the count's index sets in the heat ink so it clears AA as text.
 */
export function Eyebrow({ index, total, children }: { index: number; total: number; children: ReactNode }) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className={cn("relative flex h-12 items-center gap-3 border-b border-border-faint text-mono-x-small", gutter)}>
      <span aria-hidden className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 bg-heat-100" />
      <span className="text-black-alpha-32">
        [ <span className="text-heat-ink">{pad(index)}</span> / {pad(total)} ]
      </span>
      <span aria-hidden className="text-black-alpha-24">
        ·
      </span>
      <span className="text-black-alpha-48">{children}</span>
    </div>
  );
}

/** A section's heading block: the title on the left, the paragraph that frames it on the right from lg. */
export function SectionHead({ title, children, id }: { title: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div
      className={cn(
        "grid gap-4 pt-16 pb-10 sm:pt-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-end lg:gap-12 lg:pb-14",
        gutter,
      )}
    >
      <h2
        id={id}
        className="max-w-xl text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]"
      >
        {title}
      </h2>
      {children && <p className="max-w-xl text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">{children}</p>}
    </div>
  );
}

/**
 * The landing page's primary action: Graphite ink, not Heat. White on Heat is 3.3:1, under AA at
 * this size, so the orange stays with the flame and the headline and the button stays legible.
 */
export const primaryButton =
  "inline-flex h-11 items-center justify-center gap-2 rounded-10 bg-foreground px-5 text-[15px] font-medium text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** The quiet second action beside it: a hairline outline on the card ground. */
export const secondaryButton =
  "inline-flex h-11 items-center justify-center gap-2 rounded-10 border border-border-muted bg-card px-5 text-[15px] font-medium text-foreground outline-none transition-colors hover:bg-black-alpha-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** An inline text link that reads as one: full ink, an underline on hover, a visible focus ring. */
export const textLink =
  "tap relative inline-flex items-center gap-1 rounded-4 text-label-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50";
