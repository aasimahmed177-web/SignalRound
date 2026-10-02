import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A panel intro's fine print: one sentence stays on the page, the how-it-works detail folds under
 * a native details element (keyboard and find-in-page work with no state to keep).
 */
export function Disclosure({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn("group", className)}>
      <summary className="flex h-6 w-fit cursor-pointer list-none items-center gap-1 text-label-x-small text-black-alpha-56 hover:text-foreground dark:text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-1.5 space-y-2 border-l border-border-faint pl-3 text-body-small text-black-alpha-56 dark:text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
