import { cn } from "@/lib/utils";
import { FirecrawlWordmark } from "./firecrawl-wordmark";
import { FlameMark } from "./flame-mark";

/**
 * "Built on Firecrawl", as the site writes it: the lit flame where the lockup's flame sits, then the
 * logotype. One link to firecrawl.dev. Sized for a header corner; `caption` adds the quiet lead-in.
 */
export function FirecrawlLockup({ caption = true, className }: { caption?: boolean; className?: string }) {
  return (
    <a
      href="https://www.firecrawl.dev"
      target="_blank"
      rel="noreferrer"
      aria-label="Built on Firecrawl"
      className={cn("group inline-flex items-center gap-2 text-foreground/80 transition-colors hover:text-foreground", className)}
    >
      {caption && <span className="hidden text-mono-x-small text-black-alpha-32 sm:inline dark:text-muted-foreground">BUILT ON</span>}
      <FlameMark size="md" live />
      <FirecrawlWordmark className="h-[15px]" />
    </a>
  );
}
