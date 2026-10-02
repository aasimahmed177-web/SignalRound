import { FlameMark } from "@/components/brand/flame-mark";
import { cn } from "@/lib/utils";

/**
 * Where the posts came from, said once and quietly. Not a link: a reader who follows a line under a
 * list of posts expects more posts, not the search docs (the landing page's How it works links those).
 * The flame sits on its own at its own colours, never boxed (docs/design.md).
 */
export function FoundWithFirecrawl({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-body-small text-muted-foreground", className)}>
      <FlameMark size="sm" />
      Found on X with Firecrawl search
    </p>
  );
}
